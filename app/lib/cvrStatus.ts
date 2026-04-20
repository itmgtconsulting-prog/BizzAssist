/**
 * cvrStatus — lightweight CVR-status lookup via CVR ES.
 *
 * Returns the currently valid virksomhedsnavn and whether the company is
 * ceased (livsforloeb.gyldigTil is set OR virksomhedMetadata.sammensatStatus
 * === "Ophørt"). Used by ejerskab-routes to filter out historical owners
 * that EJF still lists as current.
 *
 * Sources this against the same CVR ES cluster (distribution.virk.dk) as
 * /api/cvr-public/related and /api/ejerskab/chain — kept as a shared helper
 * so all three stay in sync on the ceased-detection logic.
 */

import { logger } from '@/app/lib/logger';
import { LruCache } from '@/app/lib/lruCache';

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';

// BIZZ-600: LRU-cache for CVR-status. Samme CVR slås op mange gange
// på tværs af ejerskab-routes (ejendomme-by-owner, chain, filter osv.).
// Cache holder 150 entries i 1 time — trimmes automatisk ved overskridelse.
const cvrStatusCache = new LruCache<number, CvrStatus>({ maxSize: 150, ttlMs: 3_600_000 });

/**
 * Internal test helper — nulstiller cvrStatus LRU så unit-tests kan
 * verificere fetch-mocks uden cached-hit-interference. Ikke beregnet til
 * produktions-brug.
 */
export function __clearCvrStatusCacheForTests(): void {
  cvrStatusCache.clear();
}

export interface CvrStatus {
  cvr: number;
  /** Active virksomhedsnavn as of today, or null when unknown */
  navn: string | null;
  /** True when CVR livsforloeb has ended or sammensatStatus is "Ophørt" */
  isCeased: boolean;
}

type Periodic = { periode?: { gyldigFra?: string | null; gyldigTil?: string | null } };

/**
 * Finder periode-record der er gyldig NU — dvs. uden gyldigTil sat.
 * Falder tilbage til sidste record hvis ingen aktiv findes.
 */
function gyldigNu<T extends Periodic>(arr: T[]): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/**
 * Slå CVR-status + navn op for ét CVR-nummer. Returnerer null ved net-fejl
 * eller manglende credentials — kalderen bør falde tilbage til "ikke-ceased"
 * så en nedetid ikke skjuler ellers gyldige ejere.
 *
 * @param cvr - 8-cifret CVR-nummer
 * @returns CvrStatus eller null ved fejl
 */
export async function hentCvrStatus(cvr: number): Promise<CvrStatus | null> {
  // BIZZ-600: Returnér cached resultat hvis tilgængeligt.
  const cached = cvrStatusCache.get(cvr);
  if (cached) return cached;

  const user = process.env.CVR_ES_USER ?? '';
  const pass = process.env.CVR_ES_PASS ?? '';
  if (!user || !pass) return null;

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const query = {
    query: { term: { 'Vrvirksomhed.cvrNummer': cvr } },
    _source: ['Vrvirksomhed.navne', 'Vrvirksomhed.livsforloeb', 'Vrvirksomhed.virksomhedMetadata'],
    size: 1,
  };

  try {
    const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      hits?: { hits?: Array<{ _source?: { Vrvirksomhed?: unknown } }> };
    };
    const hit = json.hits?.hits?.[0]?._source?.Vrvirksomhed as Record<string, unknown> | undefined;
    if (!hit) {
      const result: CvrStatus = { cvr, navn: null, isCeased: false };
      cvrStatusCache.set(cvr, result);
      return result;
    }

    const navne = Array.isArray(hit.navne) ? (hit.navne as (Periodic & { navn?: string })[]) : [];
    const navn = gyldigNu(navne)?.navn ?? null;

    const livsforloeb = Array.isArray(hit.livsforloeb) ? (hit.livsforloeb as Periodic[]) : [];
    const harSlutdato = livsforloeb.some((l) => l.periode?.gyldigTil != null);
    const meta = hit.virksomhedMetadata as Record<string, unknown> | undefined;
    const sammensatStatus = typeof meta?.sammensatStatus === 'string' ? meta.sammensatStatus : '';
    const isCeased = harSlutdato || sammensatStatus === 'Ophørt';

    const result: CvrStatus = { cvr, navn, isCeased };
    cvrStatusCache.set(cvr, result);
    return result;
  } catch (err) {
    logger.warn('[cvrStatus] lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Batch-opslag med begrænset concurrency. Ukendte/fejlede CVR-numre
 * udelades fra resultat-mappet, så kalderen kan behandle dem som
 * "ikke-ceased" (konservativt default).
 *
 * @param cvrs - Unikke CVR-numre at slå op
 * @param concurrency - Antal parallelle opslag (default 8)
 */
export async function hentCvrStatusBatch(
  cvrs: number[],
  concurrency = 8
): Promise<Map<number, CvrStatus>> {
  const unique = Array.from(new Set(cvrs));
  const out = new Map<number, CvrStatus>();

  for (let i = 0; i < unique.length; i += concurrency) {
    const chunk = unique.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((cvr) => hentCvrStatus(cvr)));
    chunk.forEach((cvr, idx) => {
      const status = results[idx];
      if (status) out.set(cvr, status);
    });
  }

  return out;
}
