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
 * - virksomhed_status - Komma-separeret liste af status-kategorier (aktiv|
 *                   under_konkurs|oploest_konkurs|fusioneret|tvangsoploest).
 *                   Fraværende = default kun 'aktiv' (skjuler ophørte selskaber).
 *                   Udledes fra cvr_virksomhed.status via cvrStatusMapping (BIZZ-1962).
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
 * @returns { kandidater: [...], total: number, total_capped: boolean } — total
 *   er cappet ved COUNT_CAP (50.000); total_capped=true betyder "mindst så mange".
 *   Hver kandidat har desuden
 *   deltager_er_virksomhed (boolean), deltager_cvr (string|null, kun ved unikt match),
 *   virksomhed_status_raw (rå CVR-status-JSON), virksomhed_status_kode (udledt kategori)
 *   og deltager_status_raw (rå status, kun ved entydigt virksomheds-match) — BIZZ-1962
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
  // BIZZ-1962: virksomheds-status-filter (kategorier fra cvrStatusMapping).
  // Default (param fraværende) = kun aktive selskaber (skjuler ophørte/konkursramte).
  const virksomhedStatusParam = searchParams.get('virksomhed_status');
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 200);
  const offset = Number(searchParams.get('offset')) || 0;
  // BIZZ-1980: øvre grænse for det eksakte COUNT. En eksakt COUNT over den dyre
  // jsonb status-CASE skalerer til 15-18s for brede filtre (1M+ rækker) og kan
  // ramme 25s-timeouten → før faldt total stille til 0 (tom radar trods data).
  // Vi tæller højst COUNT_CAP+1 rækker via subquery-LIMIT; over cap'en vises
  // "COUNT_CAP+" i UI'et. Reelle filtrerede visninger (< 50k) er stadig eksakte.
  const COUNT_CAP = 50000;

  // Reel ejerskabs-ændringsdato. For entry/increase er det gyldig_fra (tiltrædelse/
  // forøgelse); for exit/decrease ligger den meningsfulde dato i gyldig_til (fratrædelse).
  // COALESCE(gyldig_til, gyldig_fra) giver én samlet, date-typet ændringsdato. Adskilt
  // fra sidst_opdateret (per-række indrapporterings-dato — egen filter-akse).
  const AENDRINGSDATO = 'COALESCE(k.gyldig_til, k.gyldig_fra)';

  // BIZZ-1962/BIZZ-1974: SQL-CASE der udleder status-kategori fra
  // cvr_virksomhed.status (JSON-blob) OG den autoritative ophoert-dato.
  // MATCHER 1:1 deriveCvrStatusKode() i app/lib/cvrStatusMapping.ts så
  // server-filter og klient-badge altid er enige. left()='{' guard undgår at
  // caste ikke-JSON tekst til jsonb (ville kaste og vælte hele queryen).
  //
  // BIZZ-1974: status-blobben er NULL for ~2.1M rækker (holder kun insolvens-
  // hændelser), så den autoritative ceased-markør er ophoert-datoen. Insolvens
  // fra blobben er mere specifik og vinder; ellers ⟹ ophoert hvis dato sat.
  const ophoertSql = (alias: string): string =>
    `${alias}.ophoert IS NOT NULL AND ${alias}.ophoert <= CURRENT_DATE`;
  const statusKategoriSql = (alias: string): string =>
    `CASE
       WHEN ${alias}.status IS NOT NULL AND left(${alias}.status, 1) = '{'
            AND (${alias}.status::jsonb->>'statustekst') = 'Ophævelse af dekret'
         THEN CASE WHEN ${ophoertSql(alias)} THEN 'ophoert' ELSE 'aktiv' END
       WHEN ${alias}.status IS NOT NULL AND left(${alias}.status, 1) = '{'
            AND (${alias}.status::jsonb->>'statustekst') = 'Regnskab og boafslutning' THEN 'oploest_konkurs'
       WHEN ${alias}.status IS NOT NULL AND left(${alias}.status, 1) = '{'
            AND (${alias}.status::jsonb->>'kreditoplysningtekst') IS NOT NULL THEN 'under_konkurs'
       WHEN ${ophoertSql(alias)} THEN 'ophoert'
       ELSE 'aktiv'
     END`;

  // Whitelist af gyldige status-kategorier (mod SQL-injektion i IN-listen).
  const GYLDIGE_STATUS = new Set([
    'aktiv',
    'ophoert',
    'under_konkurs',
    'oploest_konkurs',
    'fusioneret',
    'tvangsoploest',
  ]);
  // Default = kun 'aktiv' når param mangler. Tom param ⟹ også default-aktiv
  // (undgå tomt resultat ved fx ?virksomhed_status=).
  const valgteStatus = (virksomhedStatusParam ?? 'aktiv')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => GYLDIGE_STATUS.has(s));
  const statusFilterKategorier = valgteStatus.length > 0 ? valgteStatus : ['aktiv'];

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
    // BIZZ-1962: status-filter aktivt når ikke alle 5 kategorier er valgt
    // (alle valgt ⟹ ingen effektiv filtrering, spring join over for fart).
    const statusFilterAktiv = statusFilterKategorier.length < GYLDIGE_STATUS.size;
    const needCompanyJoin = brancheKoder.length > 0 || statusFilterAktiv;
    if (brancheKoder.length > 0) {
      conditions.push(`v.branche_kode IN (${brancheKoder.map((b) => `'${b}'`).join(',')})`);
    }
    if (statusFilterAktiv) {
      conditions.push(
        `${statusKategoriSql('v')} IN (${statusFilterKategorier.map((s) => `'${s}'`).join(',')})`
      );
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
    // BIZZ-1980: cap COUNT med subquery-LIMIT så scan stopper tidligt (< 4s i
    // stedet for 15-18s) og aldrig rammer timeouten.
    const countSql = `SELECT COUNT(*)::int AS total FROM (SELECT 1 FROM ${countFrom} WHERE ${where} LIMIT ${COUNT_CAP + 1}) s`;

    // Data-query joiner altid regnskab_cache + cvr_virksomhed for kolonne-berigelse.
    // BIZZ-1962: virksomhed_status_raw (rå JSON) + virksomhed_status_kode (udledt
    // kategori) leveres så frontend kan rendere status-badge uden selv at JSON-parse.
    // BIZZ-1967: deltager-status (aktiv/ophørt) udledes IKKE længere fra et skrøbeligt
    // navne-opslag i cvr_virksomhed (som kun virkede for entydige virksomhedsnavne og
    // efterlod NULL-status-rækker ufiltreret). cvr_deltager.is_aktiv er den autoritative
    // per-deltager aktiv-markør for BÅDE personer og virksomheder (levende person /
    // aktiv virksomhed = true, ophørt = false), keyet på enhedsnummer.
    const dataSql = `SELECT k.*, ${AENDRINGSDATO} AS aendringsdato, v.navn AS virksomhed_navn, v.branche_tekst, v.branche_kode, v.status AS virksomhed_status_raw, v.ophoert AS virksomhed_ophoert, ${statusKategoriSql('v')} AS virksomhed_status_kode, cd.is_aktiv AS deltager_is_aktiv, rc.seneste_aar AS regnskab_aar, rc.omsaetning, rc.bruttofortjeneste, rc.resultat_foer_skat AS overskud FROM mv_virksomhedshandel_kandidater k LEFT JOIN cvr_virksomhed v ON v.cvr = k.virksomhed_cvr LEFT JOIN cvr_deltager cd ON cd.enhedsnummer = k.deltager_enhedsnummer LEFT JOIN regnskab_cache rc ON rc.cvr = k.virksomhed_cvr WHERE ${where} ORDER BY ${sortCol} ${sortDir} NULLS LAST, ${AENDRINGSDATO} DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`;

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

    const data: Record<string, unknown>[] = Array.isArray(dataRes) ? dataRes : [];
    // BIZZ-1980: capped total. Når count-querien fejler (timeout/Management-API-
    // fejl) men vi HAR data, falder vi tilbage til offset+sidelængde (+1 hvis fuld
    // side) i stedet for stille 0 — så radaren ikke fejlagtigt viser "0 kandidater"
    // mens der faktisk vises rækker. total_capped flagger at antallet er > COUNT_CAP.
    const rawTotal =
      Array.isArray(countRes) && countRes[0]?.total != null ? Number(countRes[0].total) : null;
    const totalCapped = rawTotal != null && rawTotal > COUNT_CAP;
    const total =
      rawTotal != null
        ? Math.min(rawTotal, COUNT_CAP)
        : offset + data.length + (data.length === limit ? 1 : 0);

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
      // BIZZ-1962: ved unikt navne-match (cnt=1) er status entydig → MAX(status)
      // returnerer den ene rækkes status, så deltager-virksomheder også kan
      // status-markeres. Ved flertydigt navn ignoreres status (vises ikke).
      // BIZZ-1974: hent også MAX(ophoert) så deltager-status kan udledes af den
      // autoritative ophørsdato (status-blobben er NULL for de fleste selskaber).
      const resolveSql = `SELECT navn, MIN(cvr) AS cvr, COUNT(*) AS cnt, MAX(status) AS status, MAX(ophoert) AS ophoert FROM cvr_virksomhed WHERE navn = ANY(ARRAY[${navnArray}]::text[]) GROUP BY navn`;
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
        const byNavn = new Map<
          string,
          { cvr: string | null; cnt: number; status: string | null; ophoert: string | null }
        >();
        if (Array.isArray(resolveRes)) {
          for (const row of resolveRes) {
            byNavn.set(row.navn as string, {
              cvr: row.cvr != null ? String(row.cvr) : null,
              cnt: Number(row.cnt),
              status: row.status != null ? String(row.status) : null,
              ophoert: row.ophoert != null ? String(row.ophoert) : null,
            });
          }
        }
        for (const r of data) {
          const navn = typeof r.deltager_navn === 'string' ? r.deltager_navn : null;
          const match = navn ? byNavn.get(navn) : undefined;
          r.deltager_er_virksomhed = !!match;
          r.deltager_cvr = match && match.cnt === 1 ? match.cvr : null;
          // BIZZ-1962: status kun ved entydigt match (ellers er det uvist hvilket
          // selskabs status der gælder). Rå JSON — frontend udleder kategori.
          r.deltager_status_raw = match && match.cnt === 1 ? match.status : null;
          // BIZZ-1974: ophørsdato med samme entydigheds-krav som status.
          r.deltager_ophoert = match && match.cnt === 1 ? match.ophoert : null;
        }
      } catch (e) {
        // Best-effort berigelse — ved fejl falder klienten tilbage til person-link.
        logger.warn('[virksomhedshandler/kandidater] deltager-resolve fejl', { error: e });
      }
    }

    return NextResponse.json({ kandidater: data, total, total_capped: totalCapped });
  } catch (err) {
    logger.error('[virksomhedshandler/kandidater] catch', { error: err });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
