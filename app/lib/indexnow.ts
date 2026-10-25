/**
 * IndexNow — push-notifikation af nye/ændrede URLs til deltagende søgemaskiner
 * (Bing, Yandex m.fl. — Google deltager IKKE). Bing driver bl.a. ChatGPT-søgning,
 * Copilot og DuckDuckGo, så dette forbedrer AI-/alternativ søgedækning.
 *
 * Protokol: POST JSON {host, key, keyLocation, urlList} til api.indexnow.org.
 * Nøglen verificeres af søgemaskinen ved at hente keyLocation og sammenligne.
 * Nøglen er PUBLIC pr. design (ikke en hemmelighed) — serveres på
 * /api/indexnow/key. Maks 10.000 URLs pr. request (vi chunker).
 *
 * @module app/lib/indexnow
 */

import { logger } from '@/app/lib/logger';

/** Delt IndexNow-endpoint der videresender til alle deltagende søgemaskiner. */
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** Maks URLs pr. IndexNow-request (protokol-grænse). */
const MAX_PER_REQUEST = 10_000;

/** Resultat af en IndexNow-indsendelse. */
export interface IndexNowResult {
  /** Antal URLs forsøgt indsendt */
  submitted: number;
  /** Antal batches sendt */
  batches: number;
  /** HTTP-statuskoder pr. batch (200/202 = OK) */
  statuses: number[];
  /** true hvis alle batches blev accepteret (200/202) */
  ok: boolean;
}

/**
 * Indsender en liste af absolutte URLs til IndexNow i batches á maks 10.000.
 * Alle URLs skal høre til samme host som keyLocation.
 *
 * @param urls - Absolutte URLs (fx https://bizzassist.dk/virksomhed/<slug>/<cvr>)
 * @param baseUrl - Site-roden, fx https://bizzassist.dk (afleder host + keyLocation)
 * @returns Resultat med antal og statuskoder; ok=false hvis nøgle mangler eller en batch fejler
 */
export async function submitToIndexNow(urls: string[], baseUrl: string): Promise<IndexNowResult> {
  const key = process.env.INDEXNOW_KEY;
  const result: IndexNowResult = { submitted: 0, batches: 0, statuses: [], ok: false };
  if (!key) {
    logger.warn('[indexnow] INDEXNOW_KEY mangler — springer indsendelse over');
    return result;
  }
  if (!urls.length) {
    result.ok = true;
    return result;
  }

  const base = baseUrl.trim().replace(/\/$/, '');
  const host = base.replace(/^https?:\/\//, '');
  const keyLocation = `${base}/api/indexnow/key`;

  let allOk = true;
  for (let i = 0; i < urls.length; i += MAX_PER_REQUEST) {
    const urlList = urls.slice(i, i + MAX_PER_REQUEST);
    try {
      const res = await fetch(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host, key, keyLocation, urlList }),
        signal: AbortSignal.timeout(15_000),
      });
      result.statuses.push(res.status);
      result.batches += 1;
      result.submitted += urlList.length;
      // 200 = OK, 202 = modtaget (nøgle-validering pending). Alt andet = fejl.
      if (res.status !== 200 && res.status !== 202) allOk = false;
    } catch (err) {
      logger.error('[indexnow] batch-fejl:', err instanceof Error ? err.message : err);
      result.statuses.push(0);
      result.batches += 1;
      allOk = false;
    }
  }

  result.ok = allOk;
  return result;
}
