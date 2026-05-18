/**
 * Direct Tinglysning ejere lookup — bypasses HTTP self-call overhead.
 *
 * BIZZ-1582: Extracted from /api/tinglysning/route.ts and
 * /api/tinglysning/summarisk/route.ts so that /api/ejerskab/chain
 * can call this directly instead of making two sequential internal HTTP
 * requests (which adds 200-600ms of overhead per round-trip).
 *
 * Flow:
 *   1. Search Tinglysning by BFE → get UUID (with cache-first from tinglysning_cache)
 *   2. Fetch ejdsummarisk XML by UUID → parse adkomsthavere
 *   3. Return ejere[] (same shape as /api/tinglysning/summarisk?section=ejere)
 *
 * @module app/lib/tinglysning/fetchTlEjere
 */

import { tlFetch } from '@/app/lib/tlFetch';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TlEjer {
  navn: string;
  cvr: string | null;
  type: 'person' | 'selskab';
  adkomstType: string | null;
  andel: string | null;
  overtagelsesdato: string | null;
  koebesum: number | null;
  adresse: string | null;
}

export interface TlEjereResult {
  uuid: string | null;
  ejere: TlEjer[];
  fejl: string | null;
}

// ─── In-memory XML cache (matches summarisk/route.ts pattern) ───────────────

const xmlCache = new Map<string, { status: number; body: string; ts: number }>();
const XML_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch XML from Tinglysning with in-memory cache + optional truncation.
 */
async function cachedTlFetch(
  urlPath: string,
  maxBytes = 0
): Promise<{ status: number; body: string }> {
  const cached = xmlCache.get(urlPath);
  if (cached && Date.now() - cached.ts < XML_CACHE_TTL) {
    return { status: cached.status, body: cached.body };
  }

  const result = await tlFetch(urlPath, { accept: 'application/xml' });
  let body = result.body;
  const truncated = maxBytes > 0 && body.length >= maxBytes;
  if (truncated) body = body.slice(0, maxBytes);
  if (!truncated) {
    xmlCache.set(urlPath, { status: result.status, body, ts: Date.now() });
  }
  return { status: result.status, body };
}

// ─── Step 1: BFE → UUID ────────────────────────────────────────────────────

/**
 * Søger Tinglysning efter BFE og returnerer UUID.
 * Cache-first fra tinglysning_cache tabel.
 */
async function searchBfeForUuid(bfe: string): Promise<string | null> {
  // Cache-first
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached } = await (admin as any)
      .from('tinglysning_cache')
      .select('data, stale_after')
      .eq('bfe_nummer', parseInt(bfe, 10))
      .maybeSingle();
    if (cached?.data?.uuid && cached.stale_after && new Date(cached.stale_after) > new Date()) {
      return cached.data.uuid as string;
    }
  } catch {
    // Cache-fejl er non-fatal
  }

  // Live search
  const hasCert = !!(
    process.env.TINGLYSNING_CERT_PATH ||
    process.env.NEMLOGIN_DEVTEST4_CERT_PATH ||
    process.env.TINGLYSNING_CERT_B64 ||
    process.env.NEMLOGIN_DEVTEST4_CERT_B64
  );
  const hasProxy = !!process.env.DF_PROXY_URL;
  const hasPassword = !!(
    process.env.TINGLYSNING_CERT_PASSWORD || process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD
  );
  if (!hasProxy && (!hasCert || !hasPassword)) return null;

  try {
    const searchRes = await tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
    if (searchRes.status !== 200) return null;

    const searchData = JSON.parse(searchRes.body);
    const items = searchData?.items ?? [];
    if (items.length === 0) return null;

    return String(items[0].uuid ?? '') || null;
  } catch (err) {
    logger.warn('[tl/direkt] BFE search fejl:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Step 2: UUID → ejere (parse adkomsthavere from summarisk XML) ──────

/**
 * Henter ejdsummarisk XML og parser adkomsthavere.
 * Kun ejere-sektionen bruges (25KB truncation — adkomst er altid øverst).
 */
async function parseSummariskEjere(uuid: string): Promise<TlEjer[]> {
  // BIZZ-1615: Retry med backoff ved 429
  let res = await cachedTlFetch(`/ejdsummarisk/${uuid}`, 25_000);
  if (res.status === 429) {
    for (const delayMs of [1000, 3000, 8000]) {
      await new Promise((r) => setTimeout(r, delayMs));
      res = await cachedTlFetch(`/ejdsummarisk/${uuid}`, 25_000);
      if (res.status !== 429) break;
    }
  }

  if (res.status !== 200) return [];

  const xml = res.body;
  const ejere: TlEjer[] = [];

  const adkomstSection =
    xml.match(/AdkomstSummariskSamling[\s\S]*?<\/ns:AdkomstSummariskSamling/)?.[0] ?? '';
  const adkomstEntries = [
    ...adkomstSection.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/ns:AdkomstSummarisk/g),
  ];

  for (const [, entry] of adkomstEntries) {
    const adkomstType = entry.match(/AdkomstType[^>]*>([^<]+)/)?.[1] ?? null;
    const overtagelsesdato =
      entry.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ?? null;
    const kontantKoebesumStr = entry.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1];
    const iAltKoebesumStr = entry.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1];
    const kontantKoebesum = kontantKoebesumStr ? parseInt(kontantKoebesumStr, 10) : null;
    const iAltKoebesum = iAltKoebesumStr ? parseInt(iAltKoebesumStr, 10) : null;
    const koebesum = kontantKoebesum ?? iAltKoebesum;

    const havere = [...entry.matchAll(/Adkomsthaver>([\s\S]*?)<\/ns:Adkomsthaver/g)];
    for (const [, haver] of havere) {
      const allNames = [...haver.matchAll(/<[^\/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)];
      const nameStr = allNames
        .map((m) => m[1])
        .filter((n) => n.length > 1)
        .join(' ');

      const cvr = haver.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;

      const taellerStr = haver.match(/Taeller[^>]*>([^<]+)/)?.[1];
      const naevnerStr = haver.match(/Naevner[^>]*>([^<]+)/)?.[1];
      const taeller = taellerStr ? parseInt(taellerStr, 10) : null;
      const naevner = naevnerStr ? parseInt(naevnerStr, 10) : null;
      const andel =
        taeller != null && naevner != null && naevner > 0
          ? `${Math.round((taeller / naevner) * 100)}%`
          : null;

      const streetName = haver.match(/StreetName[^>]*>([^<]+)/)?.[1];
      const houseNr = haver.match(/StreetBuildingIdentifier[^>]*>([^<]+)/)?.[1];
      const postCode = haver.match(/PostCodeIdentifier[^>]*>([^<]+)/)?.[1];
      const district = haver.match(/DistrictName[^>]*>([^<]+)/)?.[1];
      const adresse =
        streetName && houseNr
          ? `${streetName} ${houseNr}${postCode ? `, ${postCode}` : ''}${district ? ` ${district}` : ''}`
          : null;

      if (nameStr) {
        ejere.push({
          navn: nameStr.trim(),
          cvr,
          type: cvr ? 'selskab' : 'person',
          adkomstType,
          andel,
          overtagelsesdato,
          koebesum: isNaN(koebesum ?? NaN) ? null : koebesum,
          adresse,
        });
      }
    }
  }

  return ejere;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Henter ejere fra Tinglysning direkte (uden HTTP self-call).
 *
 * 1. Søg BFE → få UUID (cache-first)
 * 2. Hent summarisk XML → parse adkomsthavere
 *
 * @param bfe - BFE-nummer som string
 * @returns UUID + ejere + eventuel fejlbesked
 */
export async function fetchTlEjereDirekt(bfe: string): Promise<TlEjereResult> {
  try {
    const uuid = await searchBfeForUuid(bfe);
    if (!uuid) return { uuid: null, ejere: [], fejl: null };

    const ejere = await parseSummariskEjere(uuid);
    return { uuid, ejere, fejl: null };
  } catch (err) {
    logger.warn('[tl/direkt] Fejl:', err instanceof Error ? err.message : err);
    return { uuid: null, ejere: [], fejl: 'Tinglysning fejl' };
  }
}
