/**
 * Cron: ISR cache warming — /api/cron/warm-cache
 *
 * Varmer ISR-cachen for populære ejendoms- og virksomhedssider ved at
 * fetche alle URLs fra sitemappet. Sikrer at sider altid er friske
 * når Google crawler dem, selvom ingen bruger har besøgt dem for nylig.
 *
 * Workflow:
 *   1. Henter /sitemap.xml og parser alle <loc>-URLs
 *   2. Fetcher hver URL (HEAD + GET) for at trigge ISR-rendering
 *   3. Begrænset til MAX_URLS pr. kørsel for at holde sig inden for Vercel timeout
 *   4. Fejl på enkelt-URLs afbryder ikke kørslen — logges og fortsætter
 *
 * Sikring:
 *   - Kræver CRON_SECRET header (Vercel Cron eller manuelt kald)
 *
 * Trigger:
 *   - Vercel Cron: "0 *\/6 * * *" (hver 6. time)
 *   - Manuel: GET /api/cron/warm-cache?secret=<CRON_SECRET>
 *
 * @module api/cron/warm-cache
 */
import { NextRequest, NextResponse } from 'next/server';

/** Max antal URLs der varmes pr. kørsel (Vercel timeout-sikring) */
const MAX_URLS = 100;

/** Timeout pr. URL-fetch i ms */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Verificerer CRON_SECRET fra Authorization-header eller query-param.
 *
 * @param request - Indkommende Next.js request
 * @returns true hvis autentificeret
 */
function verifyCronSecret(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (
    request.headers.get('authorization') === `Bearer ${secret}` ||
    new URL(request.url).searchParams.get('secret') === secret
  );
}

/**
 * Parser alle <loc>-URLs fra en sitemap XML-streng.
 *
 * @param xml - Sitemap XML som tekst
 * @returns Array af absolutte URLs
 */
function parseSitemapUrls(xml: string): string[] {
  const matches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g);
  return Array.from(matches, (m) => m[1]);
}

/**
 * Henter en URL for at trigge ISR-rendering.
 * Bruger GET — ISR kræver en fuld side-request for at populere cachen.
 *
 * @param url - Absolut URL der skal varmes
 * @returns true hvis HTTP-status var 2xx eller 3xx
 */
async function warmUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      // Undgå at Next.js deduplikerer denne interne fetch
      cache: 'no-store',
      headers: { 'x-cache-warm': '1' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

/**
 * GET /api/cron/warm-cache
 *
 * Henter sitemap, parser URLs og varmer cachen for op til MAX_URLS sider.
 * Returnerer JSON med statistik over kørslen.
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');

  // Hent sitemap
  let sitemapXml: string;
  try {
    const res = await fetch(`${baseUrl}/sitemap.xml`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Sitemap fetch fejlede: HTTP ${res.status}` },
        { status: 502 }
      );
    }
    sitemapXml = await res.text();
  } catch (err) {
    return NextResponse.json({ error: `Kunne ikke hente sitemap: ${err}` }, { status: 502 });
  }

  const allUrls = parseSitemapUrls(sitemapXml);
  const urls = allUrls.slice(0, MAX_URLS);

  console.log(`[warm-cache] Sitemap: ${allUrls.length} URLs — varmer ${urls.length}`);

  let warmed = 0;
  let failed = 0;
  const failedUrls: string[] = [];

  for (const url of urls) {
    const ok = await warmUrl(url);
    if (ok) {
      warmed++;
    } else {
      failed++;
      failedUrls.push(url);
    }
  }

  console.log(`[warm-cache] Færdig: ${warmed} ok, ${failed} fejl af ${urls.length} sider`);

  return NextResponse.json({
    ok: true,
    sitemapTotal: allUrls.length,
    attempted: urls.length,
    warmed,
    failed,
    ...(failedUrls.length > 0 ? { failedUrls: failedUrls.slice(0, 20) } : {}),
  });
}
