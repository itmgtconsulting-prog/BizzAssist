/**
 * GET /sitemap/:id — bypass the Next.js sitemap() metadata API and emit XML directly.
 *
 * BIZZ-645: The Next.js built-in metadata sitemap (app/sitemap.ts with
 * generateSitemaps + default export returning MetadataRoute.Sitemap) produced
 * empty <urlset></urlset> on prod despite the default export returning 1006
 * entries when called directly from the debug endpoint. Root cause looks like
 * a Next.js 16.2.3 metadata-route serialization bug. We sidestep it entirely
 * by owning the XML rendering here.
 *
 * Serves /sitemap/0.xml, /sitemap/1.xml, etc. (50k URLs per file).
 * /sitemap/0.xml also includes the STATIC_PAGES list.
 *
 * @module app/sitemap/[id]
 */

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

// Always run fresh on every request — the DB contents change daily via cron
// and we must not serve a build-time snapshot that could be empty.
export const dynamic = 'force-dynamic';

/** Pagination size — Next.js recommends ≤ 50k URLs per sitemap file. */
const PAGE_SIZE = 50_000;

/** Root URL (trimmed defensively — earlier prod had trailing newline). */
const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk')
  .trim()
  .replace(/\/$/, '');

interface UrlEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

/**
 * Build static pages with today's date as lastmod. Some validators (including
 * Google Search Console's submit-time validator) flag entries without lastmod
 * as "Ugyldig sitemapadresse" — BIZZ-645.
 */
function staticPages(): UrlEntry[] {
  const today = new Date().toISOString().split('T')[0];
  return [
    { loc: `${BASE_URL}/`, lastmod: today, changefreq: 'weekly', priority: 1.0 },
    { loc: `${BASE_URL}/privacy`, lastmod: today, changefreq: 'yearly', priority: 0.2 },
    { loc: `${BASE_URL}/terms`, lastmod: today, changefreq: 'yearly', priority: 0.2 },
    { loc: `${BASE_URL}/cookies`, lastmod: today, changefreq: 'yearly', priority: 0.1 },
    // /login + /login/signup droppet: robots.txt har Disallow: /login/ så de
    // skal ikke ligge i sitemap'et (Google flagger mismatch mellem robots og
    // sitemap som warning/error).
  ];
}

/**
 * Escape XML special characters in URL values. Slugs should already be
 * URL-safe from generateSlug(), but defensive escaping prevents accidental
 * XML injection from malformed entity_id / slug combos.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function serializeEntry(e: UrlEntry): string {
  const parts = [`<loc>${xmlEscape(e.loc)}</loc>`];
  if (e.lastmod) parts.push(`<lastmod>${e.lastmod}</lastmod>`);
  if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
  if (e.priority != null) parts.push(`<priority>${e.priority.toFixed(1)}</priority>`);
  return `<url>${parts.join('')}</url>`;
}

/**
 * GET handler. Params arrive as { id: "0.xml" } — strip the extension
 * and parse the number. Invalid ids return 404.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: rawId } = await params;
  const idStr = rawId.replace(/\.xml$/i, '');
  const pageId = parseInt(idStr, 10);
  if (Number.isNaN(pageId) || pageId < 0) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const staticEntries = pageId === 0 ? staticPages() : [];
  const staticCount = staticEntries.length;
  const dbOffset = pageId === 0 ? 0 : pageId * PAGE_SIZE - staticCount;
  const dbLimit = PAGE_SIZE - staticCount;

  const dbEntries: UrlEntry[] = [];
  try {
    const admin = createAdminClient();
    // BIZZ-645: PostgREST/Supabase caps .range() response ved 1000 rækker
    // medmindre max-rows-config er øget. Vi chunker manuelt i 1000-stykker
    // indtil hele den ønskede range er hentet, så sitemap kan indeholde
    // op til PAGE_SIZE (50K) URLs per fil.
    const CHUNK = 1000;
    let cursor = dbOffset;
    const endExclusive = dbOffset + dbLimit;
    while (cursor < endExclusive) {
      const chunkEnd = Math.min(cursor + CHUNK - 1, endExclusive - 1);
      const { data, error } = await admin
        .from('sitemap_entries')
        .select('type, slug, entity_id, updated_at')
        .order('updated_at', { ascending: false })
        .range(cursor, chunkEnd);
      if (error) {
        logger.error('[sitemap/id] Supabase error:', error.message);
        break;
      }
      const rows = data ?? [];
      if (rows.length === 0) break;
      for (const row of rows) {
        dbEntries.push({
          loc:
            row.type === 'ejendom'
              ? `${BASE_URL}/ejendom/${row.slug}/${row.entity_id}`
              : `${BASE_URL}/virksomhed/${row.slug}/${row.entity_id}`,
          lastmod: new Date(row.updated_at).toISOString().split('T')[0],
          changefreq: 'monthly',
          priority: row.type === 'virksomhed' ? 0.8 : 0.7,
        });
      }
      if (rows.length < CHUNK) break; // final page
      cursor += CHUNK;
    }
  } catch (err) {
    logger.error('[sitemap/id] exception:', err instanceof Error ? err.message : err);
  }

  const all = [...staticEntries, ...dbEntries];
  // Newlines between <url> elements — readability for debuggers and some
  // strict validators (Google occasionally flags compact XML as malformed).
  const urls = all.map(serializeEntry).join('\n');
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls +
    `\n</urlset>\n`;

  return new NextResponse(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
      'X-Sitemap-Entries': String(all.length),
    },
  });
}
