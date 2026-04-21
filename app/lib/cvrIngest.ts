/**
 * Shared CVR ingestion helpers — reused by bulk backfill + daily delta cron.
 *
 * BIZZ-651: `/api/cron/pull-cvr-aendringer` bruger disse til at query
 * Erhvervsstyrelsens CVR-permanent ES og upserte til public.cvr_virksomhed.
 *
 * Exports:
 *   - `CvrRow` type — matches public.cvr_virksomhed columns
 *   - `VrvirksomhedDoc` type — subset af ES _source.Vrvirksomhed vi bruger
 *   - `mapVirksomhedToRow()` — ES node → CvrRow
 *   - `upsertCvrBatch()` — batch upsert med dedup
 *   - `fetchCvrAendringer()` — paginated ES query via sidstOpdateret + search_after
 *   - `getCvrEsAuthHeader()` — Basic Auth fra env
 *
 * @module app/lib/cvrIngest
 */

import { logger } from '@/app/lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Row shape for cvr_virksomhed upsert — matches migration 054 + 057 schema */
export interface CvrRow {
  cvr: string;
  samt_id: number | null;
  navn: string;
  status: string | null;
  branche_kode: string | null;
  branche_tekst: string | null;
  virksomhedsform: string | null;
  stiftet: string | null; // ISO date YYYY-MM-DD
  ophoert: string | null;
  ansatte_aar: number | null;
  ansatte_kvartal_1: number | null;
  ansatte_kvartal_2: number | null;
  ansatte_kvartal_3: number | null;
  ansatte_kvartal_4: number | null;
  adresse_json: Record<string, unknown> | null;
  sidst_opdateret: string | null;
  sidst_indlaest: string | null;
  sidst_hentet_fra_cvr: string;
  /**
   * BIZZ-652: Hele ES _source.Vrvirksomhed gemmes så cache-first runtime-swap
   * (/api/cvr-public) kan returnere præcis samme response som live-ES via
   * eksisterende mapESHit. Sat af mapVirksomhedToRow når den kaldes med full-doc.
   */
  raw_source: Record<string, unknown> | null;
}

/** Subset af ES response _source.Vrvirksomhed vi kigger på */
export interface VrvirksomhedDoc {
  cvrNummer?: number;
  samtId?: number;
  sidstOpdateret?: string;
  sidstIndlaest?: string;
  livsforloeb?: Array<{ periode?: { gyldigFra?: string; gyldigTil?: string | null } }>;
  virksomhedMetadata?: {
    nyesteNavn?: { navn?: string };
    nyesteStatus?: string | null;
    nyesteHovedbranche?: { branchekode?: string | number; branchetekst?: string };
    nyesteVirksomhedsform?: { kortBeskrivelse?: string; langBeskrivelse?: string };
    nyesteBeliggenhedsadresse?: Record<string, unknown>;
    nyesteAarsbeskaeftigelse?: { antalAnsatte?: number | null };
    nyesteKvartalsbeskaeftigelse?: Array<{
      kvartal?: number;
      antalAnsatte?: number | null;
    }>;
  };
}

// ─── ES auth + query ──────────────────────────────────────────────────────────

/**
 * Returnerer Basic Auth-header til Erhvervsstyrelsens CVR-permanent ES.
 * Returnerer null hvis CVR_ES_USER/PASS ikke er konfigureret.
 */
export function getCvrEsAuthHeader(): string | null {
  const user = process.env.CVR_ES_USER;
  const pass = process.env.CVR_ES_PASS;
  if (!user || !pass) return null;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** ES base URL — Erhvervsstyrelsens CVR distribution */
const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';

/**
 * Henter alle virksomheder ændret siden `fromDate` via paginated search_after.
 *
 * Sorterer stabilt på (sidstOpdateret asc, cvrNummer asc) så pagination
 * ikke bliver forstyrret af indeksændringer mellem sider.
 *
 * @param fromDate - ISO timestamp — vi henter alt med sidstOpdateret >= dette
 * @param pageSize - batch-size (ES tillader op til 10000)
 * @param maxPages - safety-cap på antal batches per run
 * @returns Samlet liste af Vrvirksomhed-docs
 */
export async function fetchCvrAendringer(
  fromDate: string,
  pageSize: number,
  maxPages: number
): Promise<{ docs: VrvirksomhedDoc[]; pagesFetched: number; error: string | null }> {
  const auth = getCvrEsAuthHeader();
  if (!auth) {
    return { docs: [], pagesFetched: 0, error: 'CVR_ES_USER/PASS ikke konfigureret' };
  }

  const docs: VrvirksomhedDoc[] = [];
  let searchAfter: [number, string] | null = null;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const body: Record<string, unknown> = {
      size: pageSize,
      sort: [{ 'Vrvirksomhed.sidstOpdateret': 'asc' }, { 'Vrvirksomhed.cvrNummer': 'asc' }],
      query: {
        range: {
          'Vrvirksomhed.sidstOpdateret': { gte: fromDate },
        },
      },
    };
    if (searchAfter) body.search_after = searchAfter;

    try {
      const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return { docs, pagesFetched, error: `CVR ES HTTP ${res.status}` };
      }
      const json = (await res.json()) as {
        hits?: {
          hits?: Array<{ _source?: { Vrvirksomhed?: VrvirksomhedDoc }; sort?: [number, string] }>;
        };
      };
      const hits = json.hits?.hits ?? [];
      if (hits.length === 0) break;

      for (const h of hits) {
        const v = h._source?.Vrvirksomhed;
        if (v) docs.push(v);
      }
      pagesFetched++;

      const last = hits[hits.length - 1];
      if (!last.sort || hits.length < pageSize) break;
      searchAfter = last.sort;
    } catch (err) {
      return {
        docs,
        pagesFetched,
        error: err instanceof Error ? err.message : 'CVR ES fetch exception',
      };
    }
  }

  return { docs, pagesFetched, error: null };
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

/** Uddrag periode.gyldigFra fra første livsforloeb-element som ISO date (YYYY-MM-DD) */
function extractStiftet(v: VrvirksomhedDoc): string | null {
  const first = v.livsforloeb?.[0]?.periode?.gyldigFra;
  if (!first) return null;
  // Kan være "1999-10-29" eller full ISO — trim til YYYY-MM-DD
  return first.split('T')[0];
}

/** Uddrag seneste ophoerelsesdato fra livsforloeb — null hvis aktiv */
function extractOphoert(v: VrvirksomhedDoc): string | null {
  const forloeb = v.livsforloeb ?? [];
  // Hvis seneste livsforloeb har gyldigTil sat, betyder det ophør.
  const latest = forloeb[forloeb.length - 1];
  const til = latest?.periode?.gyldigTil;
  if (!til) return null;
  return til.split('T')[0];
}

/**
 * Map ES Vrvirksomhed → CvrRow. Returnerer null for invalide/tomme records
 * (mangler cvrNummer eller navn).
 */
export function mapVirksomhedToRow(v: VrvirksomhedDoc): CvrRow | null {
  const cvr = v.cvrNummer;
  if (cvr == null) return null;
  const meta = v.virksomhedMetadata ?? {};
  const navn = meta.nyesteNavn?.navn;
  if (!navn) return null;

  const hovedbranche = meta.nyesteHovedbranche;
  const branchekodeRaw = hovedbranche?.branchekode;
  const brancheKode = branchekodeRaw != null ? String(branchekodeRaw).padStart(6, '0') : null;

  // Kvartalsbeskaeftigelse er array med typisk 1 element for "nyeste"; map
  // kvartal-nummer (1-4) → respektiv kolonne.
  const qArr = Array.isArray(meta.nyesteKvartalsbeskaeftigelse)
    ? meta.nyesteKvartalsbeskaeftigelse
    : meta.nyesteKvartalsbeskaeftigelse
      ? [meta.nyesteKvartalsbeskaeftigelse]
      : [];
  const byQ: Record<number, number | null> = { 1: null, 2: null, 3: null, 4: null };
  for (const q of qArr) {
    if (q.kvartal && q.kvartal >= 1 && q.kvartal <= 4) {
      byQ[q.kvartal] = q.antalAnsatte ?? null;
    }
  }

  return {
    cvr: String(cvr),
    samt_id: v.samtId ?? null,
    navn,
    status: meta.nyesteStatus ?? null,
    branche_kode: brancheKode,
    branche_tekst: hovedbranche?.branchetekst ?? null,
    virksomhedsform: meta.nyesteVirksomhedsform?.kortBeskrivelse ?? null,
    stiftet: extractStiftet(v),
    ophoert: extractOphoert(v),
    ansatte_aar: meta.nyesteAarsbeskaeftigelse?.antalAnsatte ?? null,
    ansatte_kvartal_1: byQ[1],
    ansatte_kvartal_2: byQ[2],
    ansatte_kvartal_3: byQ[3],
    ansatte_kvartal_4: byQ[4],
    adresse_json: (meta.nyesteBeliggenhedsadresse as Record<string, unknown>) ?? null,
    sidst_opdateret: v.sidstOpdateret ?? null,
    sidst_indlaest: v.sidstIndlaest ?? null,
    sidst_hentet_fra_cvr: new Date().toISOString(),
    // BIZZ-652: Gem hele Vrvirksomhed så runtime-swap (cvr-public) kan
    // returnere samme response som live-ES via mapESHit.
    raw_source: v as unknown as Record<string, unknown>,
  };
}

// ─── Cache lookup + writeback (BIZZ-652 runtime swap) ───────────────────────

/**
 * Maks alder for cache-hit før vi går til live-ES.
 * 7 dage = balancerer friskhed mod cache-hit-rate.
 */
export const CVR_CACHE_MAX_AGE_DAYS = 7;

/**
 * Slå en virksomhed op i cvr_virksomhed-cachen. Returnerer den rå
 * Vrvirksomhed-_source hvis frisk nok, ellers null.
 *
 * Cache-policy: hit hvis `sidst_hentet_fra_cvr > now - 7 dage`. Ældre cache
 * = miss → caller falder tilbage til live-ES + writeback.
 *
 * @param admin - Supabase admin-client (bypasser RLS)
 * @param cvr - CVR-nummer som string (8 cifre)
 * @returns Hele Vrvirksomhed-dokument fra raw_source, eller null ved miss
 */
export async function fetchCvrFromCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  cvr: string
): Promise<Record<string, unknown> | null> {
  const maxAgeMs = CVR_CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const minFreshness = new Date(Date.now() - maxAgeMs).toISOString();

  const { data, error } = await admin
    .from('cvr_virksomhed')
    .select('raw_source, sidst_hentet_fra_cvr')
    .eq('cvr', cvr)
    .gte('sidst_hentet_fra_cvr', minFreshness)
    .maybeSingle();

  if (error) {
    logger.warn('[cvrIngest] Cache lookup fejl:', error.message);
    return null;
  }
  if (!data) return null;
  const raw = (data as { raw_source?: Record<string, unknown> | null }).raw_source;
  return raw ?? null;
}

/**
 * Skriv en enkelt Vrvirksomhed-record tilbage til cachen efter live-ES hit.
 * Wrapper upsertCvrBatch med batch af 1 så vi genbruger dedup/upsert-logik.
 *
 * @param admin - Supabase admin-client
 * @param doc - Rå Vrvirksomhed-doc fra live-ES
 * @returns true hvis skrevet, false hvis doc ikke kunne mappes
 */
export async function writebackCvrToCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  doc: VrvirksomhedDoc
): Promise<boolean> {
  const row = mapVirksomhedToRow(doc);
  if (!row) return false;
  const res = await upsertCvrBatch(admin.from('cvr_virksomhed'), [row]);
  return res.upserted > 0;
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Dedupliker på CVR + batch upsert til cvr_virksomhed.
 *
 * Samme CVR kan returneres flere gange hvis vi fetcher overlappende intervaller
 * (delta-sync gør dette bevidst for safety). In-memory dedup — sidste forekomst
 * vinder.
 *
 * @param table - Supabase table-handle
 * @param batch - CvrRows der skal upsert
 * @returns { upserted, failed }
 */
export async function upsertCvrBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  batch: CvrRow[]
): Promise<{ upserted: number; failed: number }> {
  if (batch.length === 0) return { upserted: 0, failed: 0 };

  const seen = new Map<string, CvrRow>();
  for (const row of batch) seen.set(row.cvr, row);
  const deduped = Array.from(seen.values());

  const { error } = await table.upsert(deduped, {
    onConflict: 'cvr',
    ignoreDuplicates: false,
  });
  if (error) {
    logger.error('[cvrIngest] Batch upsert fejl:', error.message);
    return { upserted: 0, failed: batch.length };
  }
  return { upserted: deduped.length, failed: 0 };
}
