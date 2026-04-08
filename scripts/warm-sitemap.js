/**
 * warm-sitemap.js — Sitemap pre-warming script (BIZZ-96)
 *
 * Fetches /sitemap.xml, parses all <loc> URLs, then sends HEAD requests
 * to each URL (max 10 concurrent) to warm the CDN/ISR cache.
 *
 * Usage:
 *   node scripts/warm-sitemap.js
 *
 * Environment variables:
 *   NEXT_PUBLIC_APP_URL — base URL of the app (defaults to https://bizzassist.dk)
 *
 * Exit codes:
 *   0 — success (or ≤10% failure rate)
 *   1 — >10% of URLs failed to warm
 *
 * @module scripts/warm-sitemap
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Base app URL — override via env for staging/preview deployments */
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://bizzassist.dk').replace(/\/$/, '');

/** Maximum concurrent HEAD requests */
const CONCURRENCY = 10;

/** Request timeout in milliseconds per URL */
const TIMEOUT_MS = 15_000;

/** Failure-rate threshold above which the script exits with code 1 */
const FAILURE_THRESHOLD = 0.1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetches the sitemap XML from `${APP_URL}/sitemap.xml`.
 *
 * @returns Raw XML string
 * @throws If the fetch fails or returns a non-2xx status
 */
async function fetchSitemap() {
  const url = `${APP_URL}/sitemap.xml`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Sitemap fetch failed: HTTP ${res.status} from ${url}`);
  }
  return res.text();
}

/**
 * Parses all `<loc>` values from a sitemap XML string.
 *
 * @param xml - Raw sitemap XML
 * @returns Array of absolute URL strings
 */
function parseLocUrls(xml) {
  const matches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g);
  return Array.from(matches, (m) => m[1]);
}

/**
 * Sends a HEAD request to the given URL to warm the cache.
 *
 * @param url - Absolute URL to warm
 * @returns `true` if the response status was 2xx or 3xx, `false` otherwise
 */
async function warmUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'x-cache-warm': '1' },
    });
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

/**
 * Simple async concurrency limiter.
 * Processes `items` by calling `fn(item)` with at most `limit` parallel tasks.
 *
 * p-limit is an ESM-only package that requires a dynamic import. To avoid
 * adding a build step or changing package type, we implement a lightweight
 * equivalent inline. If p-limit is available it will be preferred; otherwise
 * this fallback is used.
 *
 * @template T
 * @param {T[]} items - Items to process
 * @param {(item: T) => Promise<boolean>} fn - Async function returning a boolean result
 * @param {number} limit - Max concurrent executions
 * @returns {Promise<boolean[]>} Results in the same order as `items`
 */
async function withConcurrency(items, fn, limit) {
  // Attempt to use p-limit if installed (ESM dynamic import)
  let pLimit;
  try {
    const mod = await import('p-limit');
    pLimit = mod.default ?? mod;
  } catch {
    pLimit = null;
  }

  if (pLimit) {
    const limiter = pLimit(limit);
    return Promise.all(items.map((item) => limiter(() => fn(item))));
  }

  // Fallback: manual sliding-window concurrency
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point — fetches sitemap, warms all URLs, and exits with appropriate code.
 *
 * @returns {Promise<void>}
 */
async function main() {
  console.log(`[warm-sitemap] App URL: ${APP_URL}`);

  // 1. Fetch sitemap
  let xml;
  try {
    xml = await fetchSitemap();
  } catch (err) {
    console.error(`[warm-sitemap] ERROR: ${err.message}`);
    process.exit(1);
  }

  // 2. Parse URLs
  const urls = parseLocUrls(xml);
  if (urls.length === 0) {
    console.warn('[warm-sitemap] No <loc> URLs found in sitemap — nothing to warm.');
    process.exit(0);
  }

  console.log(`[warm-sitemap] Warming ${urls.length} URLs... (concurrency: ${CONCURRENCY})`);

  // 3. Warm concurrently
  const results = await withConcurrency(urls, warmUrl, CONCURRENCY);

  // 4. Tally results
  let warmed = 0;
  let failed = 0;
  for (const ok of results) {
    if (ok) {
      warmed++;
    } else {
      failed++;
    }
  }

  const total = urls.length;
  const failRate = failed / total;

  console.log(`[warm-sitemap] Done: ${warmed}/${total} URLs warmed (${failed} failed)`);

  // 5. Exit with code 1 if failure rate exceeds threshold
  if (failRate > FAILURE_THRESHOLD) {
    console.error(
      `[warm-sitemap] FAIL: ${(failRate * 100).toFixed(1)}% failure rate exceeds ${FAILURE_THRESHOLD * 100}% threshold`
    );
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[warm-sitemap] Unhandled error:', err);
  process.exit(1);
});
