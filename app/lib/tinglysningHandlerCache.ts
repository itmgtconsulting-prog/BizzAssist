/**
 * Salgshistorik cache via tinglysning_handler tabel (BIZZ-1550).
 *
 * Cache-first lookup for berigede handler-rows. Pipeline:
 *   1. Læs cache (tinglysning_handler) for BFE
 *   2. Hvis cache er fresh (< 14 dage) OG count matcher interface-summary →
 *      returnér cache
 *   3. Ellers trigger backfill: hent fra Tinglysning summarisk, parse alle
 *      felter, upsert cache, returnér nye rows
 *
 * Genbruger callS2S og parsing-logik fra app/lib/s2sClient.ts +
 * app/lib/tinglysningPrices.ts. Udvider sidstnævnte til at ekstrahere ALLE
 * handler-felter (køber, type, andel, fordelte beløb) — ikke kun pris.
 *
 * @module app/lib/tinglysningHandlerCache
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/app/lib/logger';

/** Cache fresh-grænse i ms — 14 dage */
const CACHE_FRESH_MS = 14 * 24 * 60 * 60 * 1000;

/** Shape af én cached handler-row */
export interface CachedHandlerRow {
  bfe_nummer: number;
  overtagelsesdato: string;
  dokument_id: string | null;
  tinglysningsdato: string | null;
  koeber_navn: string | null;
  koeber_cvr: number | null;
  adkomst_type: string | null;
  kontant_koebesum: number | null;
  ialt_koebesum: number | null;
  loesoere: number | null;
  entreprise: number | null;
  tinglysningsafgift: number | null;
  andel: string | null;
  sidst_opdateret: string;
}

/** Lazy service-role klient */
let _client: SupabaseClient | null = null;

/** Reset til test-isolation */
export function _resetHandlerCacheClientForTests(): void {
  _client = null;
}

function getServiceClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _client;
}

/**
 * Læs cached handler-rows for BFE. Returnerer [] hvis cache er tom eller
 * env mangler. fail-soft (logger.warn ved DB-fejl).
 */
export async function readCachedHandler(bfe: number): Promise<CachedHandlerRow[]> {
  const client = getServiceClient();
  if (!client) return [];
  try {
    const { data, error } = await client
      .from('tinglysning_handler')
      .select('*')
      .eq('bfe_nummer', bfe)
      .order('overtagelsesdato', { ascending: false });
    if (error || !data) return [];
    return data as CachedHandlerRow[];
  } catch (err) {
    logger.warn('[tlHandlerCache] read fejl', err);
    return [];
  }
}

/**
 * Tjek om cache er fresh (alle rows opdateret inden for CACHE_FRESH_MS).
 *
 * @param rows - Rows returneret fra readCachedHandler
 * @param now - Reference-tid (default = nu)
 */
export function isCacheFresh(rows: CachedHandlerRow[], now: Date = new Date()): boolean {
  if (rows.length === 0) return false;
  const cutoffMs = now.getTime() - CACHE_FRESH_MS;
  return rows.every((r) => new Date(r.sidst_opdateret).getTime() >= cutoffMs);
}

/**
 * Upsert berigede handler-rows til cache. Bruger composite-PK (bfe_nummer,
 * overtagelsesdato) — eksisterende rows overskrives.
 *
 * @param bfe - BFE-nummer
 * @param rows - Parsed rows uden cache-meta — funktionen sætter
 *   sidst_opdateret automatisk
 */
export async function upsertHandlerRows(
  bfe: number,
  rows: Array<Omit<CachedHandlerRow, 'bfe_nummer' | 'sidst_opdateret'>>
): Promise<number> {
  const client = getServiceClient();
  if (!client || rows.length === 0) return 0;
  try {
    const now = new Date().toISOString();
    const payload = rows.map((r) => ({
      ...r,
      bfe_nummer: bfe,
      sidst_opdateret: now,
    }));
    const { error, count } = await client
      .from('tinglysning_handler')
      .upsert(payload, { onConflict: 'bfe_nummer,overtagelsesdato', count: 'exact' });
    if (error) {
      logger.warn('[tlHandlerCache] upsert fejl', error);
      return 0;
    }
    return count ?? rows.length;
  } catch (err) {
    logger.warn('[tlHandlerCache] upsert uventet fejl', err);
    return 0;
  }
}

/**
 * Parse ALLE handler-felter fra Tinglysning summarisk XML. Udvider
 * parsePriceRowsFromSummarisk fra tinglysningPrices.ts med køber-info,
 * adkomst-type, fordelte beløb og andel.
 *
 * @param xml - Summarisk XML fra Tinglysning
 * @returns Array af parsed rows (uden bfe + sidst_opdateret)
 */
export function parseHandlerRowsFromSummarisk(
  xml: string
): Array<Omit<CachedHandlerRow, 'bfe_nummer' | 'sidst_opdateret'>> {
  // Section-matcher: håndterer både namespace-prefix (<ns:Tag>) og bart navn.
  // \b sikrer at "AdkomstSummarisk" ikke matcher inde i "AdkomstSummariskSamling".
  const adkomstSection =
    xml.match(/AdkomstSummariskSamling\b[\s\S]*?<\/[^>]*?AdkomstSummariskSamling\b/)?.[0] ?? '';
  // Inner: opening kan have prefix OG skal være lukket korrekt
  const entries = [
    ...adkomstSection.matchAll(
      /<[^>]*?AdkomstSummarisk\b[^>]*>([\s\S]*?)<\/[^>]*?AdkomstSummarisk\b/g
    ),
  ];
  const parseMoney = (s: string | undefined): number | null => {
    if (!s) return null;
    const n = parseInt(s.trim(), 10);
    return Number.isFinite(n) ? n : null;
  };
  const parseDate = (s: string | undefined): string | null => {
    if (!s) return null;
    return s.split(/[+T]/)[0] || null;
  };

  const out: Array<Omit<CachedHandlerRow, 'bfe_nummer' | 'sidst_opdateret'>> = [];
  for (const [, entry] of entries) {
    const overtagelsesdato = parseDate(entry.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]);
    if (!overtagelsesdato) continue; // PK kræver dato

    out.push({
      overtagelsesdato,
      dokument_id: entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ?? null,
      tinglysningsdato: parseDate(entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]),
      koeber_navn: entry.match(/KoeberNavn[^>]*>([^<]+)/)?.[1] ?? null,
      koeber_cvr: parseMoney(entry.match(/KoeberCVR[^>]*>([^<]+)/)?.[1]),
      adkomst_type: entry.match(/AdkomstType[^>]*>([^<]+)/)?.[1] ?? null,
      kontant_koebesum: parseMoney(entry.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1]),
      ialt_koebesum: parseMoney(entry.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1]),
      loesoere: parseMoney(entry.match(/LoesoereBeloeb[^>]*>([^<]+)/)?.[1]),
      entreprise: parseMoney(entry.match(/EntrepriseBeloeb[^>]*>([^<]+)/)?.[1]),
      tinglysningsafgift: parseMoney(entry.match(/TinglysningsAfgift[^>]*>([^<]+)/)?.[1]),
      andel: entry.match(/Andel[^>]*>([^<]+)/)?.[1] ?? null,
    });
  }
  return out;
}

/**
 * Backfill cache for én BFE. Henter summarisk fra Tinglysning, parser,
 * upserter. Returnerer antal rows skrevet.
 *
 * @param bfe - BFE at backfill
 * @param fetchSummarisk - Injectable fetcher (default = real callS2S import)
 *   så funktionen kan testes uden network
 */
export async function backfillHandlerForBfe(
  bfe: number,
  fetchSummarisk?: (bfe: number) => Promise<string>
): Promise<number> {
  let xml: string;
  try {
    if (fetchSummarisk) {
      xml = await fetchSummarisk(bfe);
    } else {
      const { callS2S, NS } = await import('@/app/lib/s2sClient');
      xml = await callS2S(
        'EjendomSummariskHent',
        `<EjendomSummariskHent xmlns="${NS.MSG}"><BFEnummer>${bfe}</BFEnummer></EjendomSummariskHent>`,
        { timeoutMs: 30_000 }
      );
    }
  } catch (err) {
    logger.warn('[tlHandlerCache] backfill: callS2S fejl', { bfe, err });
    return 0;
  }
  const rows = parseHandlerRowsFromSummarisk(xml);
  if (rows.length === 0) return 0;
  return upsertHandlerRows(bfe, rows);
}
