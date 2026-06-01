/**
 * GET /api/virksomhedshandler/kandidater
 *
 * BIZZ-1929: Henter virksomhedshandel-kandidater fra mv_virksomhedshandel_kandidater.
 * Understøtter filtrering på signal_type, tidsperiode og pagination.
 *
 * Query params:
 * - signal_type   - Filter på signal (entry|exit|increase|decrease)
 * - from_date     - Ændringsdato fra (YYYY-MM-DD, inklusiv). Filtrerer på den
 *                   reelle ejerskabs-ændringsdato = COALESCE(gyldig_til, gyldig_fra).
 *                   sidst_opdateret = per-række indrapporterings-/ingestion-dato (varierer
 *                   pr. række) og kan derfor også range-filtreres (indrapporteret_fra/til).
 * - to_date       - Ændringsdato til (YYYY-MM-DD, inklusiv). Da kolonnerne er date-typede
 *                   er begge grænser hele-dags-inklusive → samme dato i begge = 1 dag.
 * - brancher      - Komma-separeret liste af branche_kode (DB07) at filtrere på
 * - min_omsaetning / max_omsaetning - Filter på seneste regnskabs omsætning (DKK)
 * - min_bruttofortjeneste / max_bruttofortjeneste - Filter på seneste regnskabs bruttofortjeneste (DKK)
 * - min_overskud / max_overskud     - Filter på seneste regnskabs resultat før skat (DKK)
 * - sort          - Sorteringskolonne (deltager|virksomhed|branche|omsaetning|
 *                   bruttofortjeneste|overskud|aendring|aendringsdato|indrapporteret)
 * - dir           - Sorteringsretning (asc|desc, default desc)
 * - limit         - Max antal resultater (default 50, max 200)
 * - offset        - Offset for pagination
 *
 * Beriger hver kandidat med seneste regnskabstal (omsætning, bruttofortjeneste,
 * overskud = resultat før skat) fra regnskab_cache, samt branche_kode fra
 * cvr_virksomhed. Tomme værdier returneres som null (regnskab ikke cachet endnu).
 *
 * Klassificerer desuden hver deltager som person eller virksomhed via navne-opslag
 * i cvr_virksomhed (deltager_er_virksomhed + deltager_cvr) så frontend kan linke
 * virksomheds-deltagere til /dashboard/companies i stedet for person-siden.
 *
 * @returns { kandidater: [...], total: number } — hver kandidat har desuden
 *   deltager_er_virksomhed (boolean) og deltager_cvr (string|null, kun ved unikt match)
 *
 * @module app/api/virksomhedshandler/kandidater/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
// Branche-filtre på de største brancher (fx holdingselskaber) kræver et fuldt
// MV-scan + sort (~16s) da branche ikke er denormaliseret ind i MV'en. Giv
// funktionen plads til at fuldføre frem for at time-out'e filterpanelet.
export const maxDuration = 30;

/**
 * GET handler — henter kandidater med filtrering og pagination.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(req, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const signalType = searchParams.get('signal_type');
  const signalTypes = searchParams.get('signal_types');
  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  // Indrapporterings-dato = k.sidst_opdateret (per-række ingestion-tidsstempel,
  // varierer pr. række — IKKE et MV-refresh-tidsstempel). Date-range-filter.
  const indrapFra = searchParams.get('indrapporteret_fra');
  const indrapTil = searchParams.get('indrapporteret_til');
  const brancherParam = searchParams.get('brancher');
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 200);
  const offset = Number(searchParams.get('offset')) || 0;

  // Reel ejerskabs-ændringsdato. For entry/increase er det gyldig_fra (tiltrædelse/
  // forøgelse); for exit/decrease ligger den meningsfulde dato i gyldig_til (fratrædelse).
  // COALESCE(gyldig_til, gyldig_fra) giver én samlet, date-typet ændringsdato. Adskilt
  // fra sidst_opdateret (per-række indrapporterings-dato — egen filter-akse).
  const AENDRINGSDATO = 'COALESCE(k.gyldig_til, k.gyldig_fra)';

  // Sortering — whitelist af sorterbare kolonner (mod SQL-injektion). Default er
  // seneste ændringsdato. 'aendring' sorterer på absolut ejerandels-delta.
  const SORT_COLUMNS: Record<string, string> = {
    deltager: 'k.deltager_navn',
    virksomhed: 'v.navn',
    branche: 'v.branche_tekst',
    omsaetning: 'rc.omsaetning',
    bruttofortjeneste: 'rc.bruttofortjeneste',
    overskud: 'rc.resultat_foer_skat',
    aendring: 'ABS(k.current_ejerandel_pct - k.prev_ejerandel_pct)',
    aendringsdato: AENDRINGSDATO,
    indrapporteret: 'k.sidst_opdateret',
  };
  const sortKey = searchParams.get('sort') ?? '';
  const sortCol = SORT_COLUMNS[sortKey] ?? AENDRINGSDATO;
  const sortDir = searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';

  // Numerisk range-filter på regnskabstal — kun finite tal accepteres
  const numParam = (key: string): number | null => {
    const raw = searchParams.get(key);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const minOmsaetning = numParam('min_omsaetning');
  const maxOmsaetning = numParam('max_omsaetning');
  const minBruttofortjeneste = numParam('min_bruttofortjeneste');
  const maxBruttofortjeneste = numParam('max_bruttofortjeneste');
  const minOverskud = numParam('min_overskud');
  const maxOverskud = numParam('max_overskud');

  try {
    // admin client unused — using Management API to bypass PostgREST schema-cache

    // BIZZ-1935: Supabase Management API for SQL — bypasser PostgREST schema-cache
    // som ikke ser sidst_opdateret kolonnen på nye MV'er.
    const conditions: string[] = ["k.signal_type != 'unchanged'"];
    if (signalTypes) {
      const types = signalTypes
        .split(',')
        .filter(Boolean)
        .map((t) => t.replace(/[^a-z_]/g, ''));
      if (types.length > 0)
        conditions.push(`k.signal_type IN (${types.map((t) => `'${t}'`).join(',')})`);
    } else if (signalType) {
      conditions.push(`k.signal_type = '${signalType.replace(/[^a-z_]/g, '')}'`);
    }
    // Date-typede grænser → hele-dags-inklusive (samme dato i begge = 1 dag).
    if (fromDate) conditions.push(`${AENDRINGSDATO} >= '${fromDate.replace(/[^0-9-]/g, '')}'`);
    if (toDate) conditions.push(`${AENDRINGSDATO} <= '${toDate.replace(/[^0-9-]/g, '')}'`);
    // Indrapporterings-dato: cast timestamp → date for hele-dags-inklusivt range.
    if (indrapFra)
      conditions.push(`k.sidst_opdateret::date >= '${indrapFra.replace(/[^0-9-]/g, '')}'`);
    if (indrapTil)
      conditions.push(`k.sidst_opdateret::date <= '${indrapTil.replace(/[^0-9-]/g, '')}'`);

    // Branche-filter (DB07-koder) — sanitér til cifre, kræver company-join.
    const brancheKoder = (brancherParam ?? '')
      .split(',')
      .map((b) => b.replace(/[^0-9]/g, ''))
      .filter(Boolean);
    const needCompanyJoin = brancheKoder.length > 0;
    if (needCompanyJoin) {
      conditions.push(`v.branche_kode IN (${brancheKoder.map((b) => `'${b}'`).join(',')})`);
    }

    // Regnskabs-range-filter — kræver regnskab_cache-join (ekskluderer ucachede rækker).
    const needRegnskabJoin =
      minOmsaetning != null ||
      maxOmsaetning != null ||
      minBruttofortjeneste != null ||
      maxBruttofortjeneste != null ||
      minOverskud != null ||
      maxOverskud != null;
    if (minOmsaetning != null) conditions.push(`rc.omsaetning >= ${minOmsaetning}`);
    if (maxOmsaetning != null) conditions.push(`rc.omsaetning <= ${maxOmsaetning}`);
    if (minBruttofortjeneste != null)
      conditions.push(`rc.bruttofortjeneste >= ${minBruttofortjeneste}`);
    if (maxBruttofortjeneste != null)
      conditions.push(`rc.bruttofortjeneste <= ${maxBruttofortjeneste}`);
    if (minOverskud != null) conditions.push(`rc.resultat_foer_skat >= ${minOverskud}`);
    if (maxOverskud != null) conditions.push(`rc.resultat_foer_skat <= ${maxOverskud}`);

    const where = conditions.join(' AND ');
    const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
    const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').match(/\/\/([^.]+)/)?.[1];

    if (!accessToken || !projectRef) {
      return NextResponse.json({ error: 'Mangler SUPABASE_ACCESS_TOKEN' }, { status: 503 });
    }

    // Count-query joiner kun de tabeller filtrene kræver (holder COUNT hurtig).
    const countFrom =
      'mv_virksomhedshandel_kandidater k' +
      (needCompanyJoin ? ' JOIN cvr_virksomhed v ON v.cvr = k.virksomhed_cvr' : '') +
      (needRegnskabJoin ? ' JOIN regnskab_cache rc ON rc.cvr = k.virksomhed_cvr' : '');
    const countSql = `SELECT COUNT(*)::int AS total FROM ${countFrom} WHERE ${where}`;

    // Data-query joiner altid regnskab_cache + cvr_virksomhed for kolonne-berigelse.
    const dataSql = `SELECT k.*, ${AENDRINGSDATO} AS aendringsdato, v.navn AS virksomhed_navn, v.branche_tekst, v.branche_kode, rc.seneste_aar AS regnskab_aar, rc.omsaetning, rc.bruttofortjeneste, rc.resultat_foer_skat AS overskud FROM mv_virksomhedshandel_kandidater k LEFT JOIN cvr_virksomhed v ON v.cvr = k.virksomhed_cvr LEFT JOIN regnskab_cache rc ON rc.cvr = k.virksomhed_cvr WHERE ${where} ORDER BY ${sortCol} ${sortDir} NULLS LAST, ${AENDRINGSDATO} DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`;

    const [countRes, dataRes] = await Promise.all([
      fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: countSql }),
        signal: AbortSignal.timeout(25000),
      }).then((r) => r.json()),
      fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: dataSql }),
        signal: AbortSignal.timeout(25000),
      }).then((r) => r.json()),
    ]);

    const total = Array.isArray(countRes) && countRes[0]?.total != null ? countRes[0].total : 0;
    const data: Record<string, unknown>[] = Array.isArray(dataRes) ? dataRes : [];

    // En deltager kan være en PERSON eller en VIRKSOMHED, men cvr_deltager.enhedstype
    // er ikke beriget i cachen (NULL). Vi klassificerer derfor ved at slå deltager-navnet
    // op i cvr_virksomhed: unikt navne-match ⟹ virksomhed (med CVR til company-link);
    // flertydigt navn ⟹ virksomhed uden entydigt CVR; intet match ⟹ person. Kun de
    // ≤200 viste rækkers navne slås op (btree-indeks idx_cvr_virksomhed_navn → hurtigt).
    const deltagerNavne = Array.from(
      new Set(
        data
          .map((r) => (typeof r.deltager_navn === 'string' ? r.deltager_navn : null))
          .filter((n): n is string => !!n)
      )
    );
    if (deltagerNavne.length > 0) {
      const navnArray = deltagerNavne.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
      const resolveSql = `SELECT navn, MIN(cvr) AS cvr, COUNT(*) AS cnt FROM cvr_virksomhed WHERE navn = ANY(ARRAY[${navnArray}]::text[]) GROUP BY navn`;
      try {
        const resolveRes = await fetch(
          `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: resolveSql }),
            signal: AbortSignal.timeout(15000),
          }
        ).then((r) => r.json());
        const byNavn = new Map<string, { cvr: string | null; cnt: number }>();
        if (Array.isArray(resolveRes)) {
          for (const row of resolveRes) {
            byNavn.set(row.navn as string, {
              cvr: row.cvr != null ? String(row.cvr) : null,
              cnt: Number(row.cnt),
            });
          }
        }
        for (const r of data) {
          const navn = typeof r.deltager_navn === 'string' ? r.deltager_navn : null;
          const match = navn ? byNavn.get(navn) : undefined;
          r.deltager_er_virksomhed = !!match;
          r.deltager_cvr = match && match.cnt === 1 ? match.cvr : null;
        }
      } catch (e) {
        // Best-effort berigelse — ved fejl falder klienten tilbage til person-link.
        logger.warn('[virksomhedshandler/kandidater] deltager-resolve fejl', { error: e });
      }
    }

    return NextResponse.json({ kandidater: data, total });
  } catch (err) {
    logger.error('[virksomhedshandler/kandidater] catch', { error: err });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
