/**
 * GET /sitemap.xml — sitemap index file that lists all cached sitemap pages.
 *
 * BIZZ-645: Google Search Console expects a canonical /sitemap.xml entry point.
 * BIZZ-890: Now reads page count from sitemap_xml_cache instead of counting
 * sitemap_entries rows (which could be inconsistent with what's actually served).
 *
 * @module app/sitemap.xml
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const dynamic = 'force-dynamic';

const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk')
  .trim()
  .replace(/\/$/, '');

/**
 * Returns a sitemap index listing all pre-generated sitemap pages.
 * Reads from sitemap_xml_cache to only list pages that actually exist
 * and can be served instantly.
 *
 * @returns XML sitemap index response
 */
export async function GET(): Promise<NextResponse> {
  let pageCount = 1;
  try {
    const admin = createAdminClient();

    // Count cached pages — only list pages that are actually pre-rendered
    const { count } = await admin
      .from('sitemap_xml_cache')
      .select('*', { count: 'exact', head: true });

    if (count && count > 0) {
      pageCount = count;
    } else {
      // Fallback: if cache is empty, estimate from sitemap_entries
      const { count: entryCount } = await admin
        .from('sitemap_entries')
        .select('*', { count: 'exact', head: true });
      const total = (entryCount ?? 0) + 4; // +4 static pages
      pageCount = Math.max(1, Math.ceil(total / 50_000));
    }
  } catch (err) {
    logger.error('[sitemap.xml] count failed:', err instanceof Error ? err.message : err);
  }

  const today = new Date().toISOString().split('T')[0];
  const entries = Array.from(
    { length: pageCount },
    (_, i) =>
      `<sitemap><loc>${BASE_URL}/sitemap/${i}.xml</loc><lastmod>${today}</lastmod></sitemap>`
  ).join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries +
    `\n</sitemapindex>\n`;

  return new NextResponse(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
    },
  });
}
