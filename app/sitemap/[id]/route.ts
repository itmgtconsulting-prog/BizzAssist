/**
 * GET /sitemap/:id — serve pre-generated sitemap XML from cache.
 *
 * BIZZ-645: Bypasses Next.js metadata sitemap API (empty <urlset> bug).
 * BIZZ-890: Now serves pre-rendered XML from sitemap_xml_cache table
 * instead of building it on-demand (which caused >60s timeouts and
 * prevented Google from indexing any pages).
 *
 * The cron job /api/cron/generate-sitemap?phase=render-xml populates
 * sitemap_xml_cache hourly. This route simply reads the cached XML.
 *
 * Fallback: if cache is empty (first deploy, table not yet populated),
 * returns a minimal sitemap with only static pages.
 *
 * @module app/sitemap/[id]
 */

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const dynamic = 'force-dynamic';

/** Root URL (trimmed defensively — earlier prod had trailing newline). */
const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk')
  .trim()
  .replace(/\/$/, '');

/**
 * GET handler. Params arrive as { id: "0.xml" } — strip the extension
 * and parse the number. Invalid ids return 404.
 *
 * @param _req - Incoming Next.js request (unused)
 * @param params - Route params containing the sitemap page id (e.g. "0.xml")
 * @returns Pre-rendered XML response or 404
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

  try {
    const admin = createAdminClient();

    // Read pre-generated XML from cache
    const { data, error } = await admin
      .from('sitemap_xml_cache')
      .select('xml, entry_count, generated_at')
      .eq('page_id', pageId)
      .maybeSingle();

    if (error) {
      logger.error('[sitemap/id] Cache read error:', error.message);
    }

    const row = data;

    if (row?.xml) {
      return new NextResponse(row.xml, {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
          'X-Sitemap-Entries': String(row.entry_count),
          'X-Sitemap-Generated': row.generated_at,
        },
      });
    }
  } catch (err) {
    logger.error('[sitemap/id] Cache read exception:', err instanceof Error ? err.message : err);
  }

  // Fallback: cache miss — return minimal sitemap for page 0, 404 for others
  if (pageId > 0) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  // Page 0 fallback with just static pages
  const today = new Date().toISOString().split('T')[0];
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `<url><loc>${BASE_URL}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
    `<url><loc>${BASE_URL}/privacy</loc><lastmod>${today}</lastmod><changefreq>yearly</changefreq><priority>0.2</priority></url>\n` +
    `<url><loc>${BASE_URL}/terms</loc><lastmod>${today}</lastmod><changefreq>yearly</changefreq><priority>0.2</priority></url>\n` +
    `<url><loc>${BASE_URL}/cookies</loc><lastmod>${today}</lastmod><changefreq>yearly</changefreq><priority>0.1</priority></url>\n` +
    `</urlset>\n`;

  return new NextResponse(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
      'X-Sitemap-Entries': '4',
      'X-Sitemap-Fallback': 'true',
    },
  });
}
