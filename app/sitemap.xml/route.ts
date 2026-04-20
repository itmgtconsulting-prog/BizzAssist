/**
 * GET /sitemap.xml — sitemap index file that lists all paginated sitemap/N.xml files.
 *
 * BIZZ-645: Google Search Console's submit flow expects a canonical
 * /sitemap.xml entry point. Our per-page sitemaps live at /sitemap/0.xml,
 * /sitemap/1.xml, … — this index file aggregates them so operators can
 * submit a single URL and GSC auto-discovers the rest.
 *
 * @module app/sitemap.xml
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50_000;

const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk')
  .trim()
  .replace(/\/$/, '');

/**
 * Count rows in sitemap_entries to decide how many paginated files to list.
 * Always includes at least sitemap/0.xml (which holds static pages).
 */
export async function GET(): Promise<NextResponse> {
  let pageCount = 1;
  try {
    const admin = createAdminClient();
    const { count } = await admin
      .from('sitemap_entries')
      .select('*', { count: 'exact', head: true });
    // Page 0 has 6 static pages + up to (PAGE_SIZE - 6) DB rows; subsequent
    // pages each fit PAGE_SIZE. Simpler ceiling: total / PAGE_SIZE rounded up.
    const total = (count ?? 0) + 6;
    pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
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
