/**
 * BIZZ-685 / BIZZ-693: Resolve historical sale prices from Tinglysning for
 * a property's EJF-derived salgshistorik rows.
 *
 * EJF's GraphQL returns ejerskab-episodes (who owned it + from when) but
 * never the actual sale price — KontantKoebesum / IAltKoebesum live only
 * in the Tinglysning adkomst-summarisk XML. We chain:
 *
 *   1. /ejendom/hovednoteringsnummer?hovednoteringsnummer={bfe}
 *        → returns [{ uuid }] for the matrikel
 *   2. /ejdsummarisk/{uuid}
 *        → returns <AdkomstSummariskSamling> with one entry per historical
 *          ejerskifte: SkoedeOvertagelsesDato + KontantKoebesum + ...
 *
 * The helper returns a date → price map keyed on the overtagelsesdato
 * (ISO YYYY-MM-DD). Callers splice matching rows into their own response.
 *
 * Cached via a small LRU — the summarisk XML is identical across requests
 * and the parsing is hot on popular BFEs. Gracefully returns an empty map
 * on any failure so callers can fall back to null-price rows.
 *
 * @module app/lib/tinglysningPrices
 */
import { tlFetch } from '@/app/lib/tlFetch';
import { LruCache } from '@/app/lib/lruCache';
import { logger } from '@/app/lib/logger';

/** Shape of a single priced adkomst-entry pulled from summarisk XML. */
export interface TinglysningPriceRow {
  /** ISO YYYY-MM-DD — SkoedeOvertagelsesDato — the business date we match on */
  overtagelsesdato: string | null;
  /** ISO YYYY-MM-DD — TinglysningsDato — surfaced for display. */
  tinglysningsdato: string | null;
  /** ISO YYYY-MM-DD — KoebsaftaleDato when present */
  koebsaftaleDato: string | null;
  /** KontantKoebesum in DKK (integer) — preferred price field */
  kontantKoebesum: number | null;
  /** IAltKoebesum in DKK — fallback when kontant is missing */
  iAltKoebesum: number | null;
  /** Dokument UUID the price came from — lets caller link to the deed */
  dokumentId: string | null;
}

const priceCache = new LruCache<number, TinglysningPriceRow[]>({
  maxSize: 150,
  ttlMs: 3_600_000,
});

/** Parse safe integer from a string possibly containing whitespace. */
function parseMoney(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract all priced adkomst-entries from the summarisk XML. Mirrors the
 * parsing used in /api/tinglysning/summarisk so our two callers agree on
 * how to pull the fields. No external ns-prefix dependency — the regex
 * uses end-tag back-references.
 */
function parsePriceRowsFromSummarisk(xml: string): TinglysningPriceRow[] {
  const adkomstSection =
    xml.match(/AdkomstSummariskSamling[\s\S]*?<\/[^:]*:?AdkomstSummariskSamling/)?.[0] ?? '';
  const entries = [
    ...adkomstSection.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g),
  ];
  const out: TinglysningPriceRow[] = [];
  for (const [, entry] of entries) {
    const overtagelsesdato =
      entry.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
    const tinglysningsdato =
      entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
    const koebsaftaleDato =
      entry.match(/KoebsaftaleDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
    const kontantKoebesum = parseMoney(entry.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1]);
    const iAltKoebesum = parseMoney(entry.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1]);
    const dokumentId = entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ?? null;
    // Only keep entries that have at least a price or a priceable date —
    // otherwise there's nothing useful to match on.
    if (kontantKoebesum == null && iAltKoebesum == null && !overtagelsesdato) continue;
    out.push({
      overtagelsesdato,
      tinglysningsdato,
      koebsaftaleDato,
      kontantKoebesum,
      iAltKoebesum,
      dokumentId,
    });
  }
  return out;
}

/**
 * Resolve historical sale prices for a BFE. Returns an empty array on any
 * failure — caller is expected to tolerate the gap.
 *
 * @param bfe - BFE number (Danish property registry key)
 */
export async function fetchTinglysningPriceRowsByBfe(bfe: number): Promise<TinglysningPriceRow[]> {
  if (!Number.isFinite(bfe) || bfe <= 0) return [];
  const cached = priceCache.get(bfe);
  if (cached) return cached;

  try {
    // Step 1: Resolve BFE → Tinglysning ejendom UUID
    const searchRes = await tlFetch(
      `/ejendom/hovednoteringsnummer?hovednoteringsnummer=${encodeURIComponent(String(bfe))}`,
      { timeout: 8000 }
    );
    if (searchRes.status !== 200 || !searchRes.body) {
      priceCache.set(bfe, []);
      return [];
    }
    let uuid: string | null = null;
    try {
      const data = JSON.parse(searchRes.body) as { items?: Array<{ uuid?: string }> };
      uuid = data.items?.[0]?.uuid ?? null;
    } catch {
      /* Tinglysning can return XML — we only care about the UUID below */
    }
    if (!uuid) {
      priceCache.set(bfe, []);
      return [];
    }

    // Step 2: Fetch summarisk XML and extract priced adkomst-entries
    const xmlRes = await tlFetch(`/ejdsummarisk/${encodeURIComponent(uuid)}`, { timeout: 15000 });
    if (xmlRes.status !== 200 || !xmlRes.body) {
      priceCache.set(bfe, []);
      return [];
    }
    const rows = parsePriceRowsFromSummarisk(xmlRes.body);
    priceCache.set(bfe, rows);
    return rows;
  } catch (err) {
    logger.warn('[tinglysningPrices] fetch failed for BFE', bfe, err);
    return [];
  }
}

/**
 * Build a date → TinglysningPriceRow lookup. Keys are the ISO YYYY-MM-DD
 * overtagelsesdato (falls back to tinglysningsdato when missing). When
 * multiple entries share a date we prefer the one with a non-null price.
 */
export function indexPriceRowsByDate(
  rows: TinglysningPriceRow[]
): Map<string, TinglysningPriceRow> {
  const map = new Map<string, TinglysningPriceRow>();
  for (const r of rows) {
    const key = (r.overtagelsesdato ?? r.tinglysningsdato ?? '').slice(0, 10);
    if (!key) continue;
    const existing = map.get(key);
    if (
      !existing ||
      ((r.kontantKoebesum != null || r.iAltKoebesum != null) &&
        existing.kontantKoebesum == null &&
        existing.iAltKoebesum == null)
    ) {
      map.set(key, r);
    }
  }
  return map;
}

/** Reset the internal cache (primarily for tests). */
export function _clearTinglysningPriceCache(): void {
  priceCache.clear();
}
