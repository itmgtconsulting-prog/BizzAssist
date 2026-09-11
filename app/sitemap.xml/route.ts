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
  let pageIds: number[] = [0];
  try {
    const admin = createAdminClient();

    // BIZZ-2235: List the ACTUAL cached page_ids (ordered), not 0..count-1.
    // Render-cursoren efterlader huller (ikke-sammenhængende page_ids), så det
    // gamle count→0..count-1 listede manglende sider (→ Google 404) OG udelod
    // eksisterende sider over count (→ ~830k URLs usynlige). Nu annonceres kun
    // sider der faktisk findes i cachen.
    const { data } = await admin
      .from('sitemap_xml_cache')
      .select('page_id')
      .order('page_id', { ascending: true });

    const ids = (data ?? []).map((r) => (r as { page_id: number }).page_id);
    if (ids.length > 0) {
      pageIds = ids;
    } else {
      // Fallback: cache tom → estimér sammenhængende sider fra sitemap_entries
      const { count: entryCount } = await admin
        .from('sitemap_entries')
        .select('*', { count: 'exact', head: true });
      const total = (entryCount ?? 0) + 4; // +4 static pages
      const n = Math.max(1, Math.ceil(total / 50_000));
      pageIds = Array.from({ length: n }, (_, i) => i);
    }
  } catch (err) {
    logger.error('[sitemap.xml] page_id lookup failed:', err instanceof Error ? err.message : err);
  }

  const today = new Date().toISOString().split('T')[0];
  const entries = pageIds
    .map(
      (id) =>
        `<sitemap><loc>${BASE_URL}/sitemap/${id}.xml</loc><lastmod>${today}</lastmod></sitemap>`
    )
    .join('\n');

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
