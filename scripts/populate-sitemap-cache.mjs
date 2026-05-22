#!/usr/bin/env node
/**
 * Populate sitemap_xml_cache directly via SQL on prod Supabase.
 *
 * Bypasses PostgREST (which has connection pool issues from Vercel)
 * and generates all sitemap XML pages in one go.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... node scripts/populate-sitemap-cache.mjs
 *
 * @module scripts/populate-sitemap-cache
 */

import { execSync } from 'child_process';

const PROJECT_REF = 'xsyldjqcntiygrtfcszm';
const PAGE_SIZE = 50_000;
const BASE_URL = 'https://bizzassist.dk';

/**
 * Run SQL query against prod via supabase CLI.
 *
 * @param {string} sql - SQL to execute
 * @returns {object[]} Parsed JSON rows
 */
function query(sql) {
  const result = execSync(
    `npx supabase db query --linked ${JSON.stringify(sql)}`,
    { encoding: 'utf-8', timeout: 120_000, env: { ...process.env, SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN } }
  );
  try {
    const parsed = JSON.parse(result);
    return parsed.rows ?? [];
  } catch {
    return [];
  }
}

/**
 * Escape XML special characters.
 *
 * @param {string} s - Input string
 * @returns {string} XML-escaped string
 */
function xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const today = new Date().toISOString().split('T')[0];

const STATIC_URLS = [
  `<url><loc>${BASE_URL}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
  `<url><loc>${BASE_URL}/privacy</loc><lastmod>${today}</lastmod><changefreq>yearly</changefreq><priority>0.2</priority></url>`,
  `<url><loc>${BASE_URL}/terms</loc><lastmod>${today}</lastmod><changefreq>yearly</changefreq><priority>0.2</priority></url>`,
  `<url><loc>${BASE_URL}/cookies</loc><lastmod>${today}</lastmod><changefreq>yearly</changefreq><priority>0.1</priority></url>`,
];

// Ensure linked to prod
console.log('Linking to prod...');
execSync(`npx supabase link --project-ref ${PROJECT_REF}`, {
  encoding: 'utf-8',
  timeout: 30_000,
  env: { ...process.env, SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN },
});

// Get total count
console.log('Counting sitemap_entries...');
const countRows = query('SELECT COUNT(*)::int as cnt FROM public.sitemap_entries');
const totalEntries = countRows[0]?.cnt ?? 0;
console.log(`Total entries: ${totalEntries}`);

if (totalEntries === 0) {
  console.error('No entries found — aborting.');
  process.exit(1);
}

const totalPages = Math.ceil((totalEntries + STATIC_URLS.length) / PAGE_SIZE);
console.log(`Will generate ${totalPages} sitemap pages`);

// Clear existing cache
console.log('Clearing existing cache...');
query('DELETE FROM public.sitemap_xml_cache');

// Generate pages using cursor-based pagination via SQL
let afterId = null;
let processedTotal = 0;

for (let pageId = 0; pageId < totalPages; pageId++) {
  const urlElements = [];

  if (pageId === 0) {
    urlElements.push(...STATIC_URLS);
  }

  const targetCount = pageId === 0 ? PAGE_SIZE - STATIC_URLS.length : PAGE_SIZE;

  // Fetch entries for this page via SQL (no PostgREST 1000-row cap)
  const whereClause = afterId ? `WHERE id > '${afterId}'` : '';
  const sql = `SELECT id, type, slug, entity_id, updated_at::date as lastmod FROM public.sitemap_entries ${whereClause} ORDER BY id ASC LIMIT ${targetCount}`;

  const rows = query(sql);

  for (const row of rows) {
    const loc = row.type === 'ejendom'
      ? `${BASE_URL}/ejendom/${xmlEscape(row.slug)}/${row.entity_id}`
      : `${BASE_URL}/virksomhed/${xmlEscape(row.slug)}/${row.entity_id}`;
    const priority = row.type === 'virksomhed' ? '0.8' : '0.7';
    urlElements.push(`<url><loc>${loc}</loc><lastmod>${row.lastmod}</lastmod><changefreq>monthly</changefreq><priority>${priority}</priority></url>`);
    afterId = row.id;
  }

  processedTotal += rows.length;

  // Build XML
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlElements.join('\n')}\n</urlset>\n`;

  // Escape single quotes for SQL insertion
  const xmlEscaped = xml.replace(/'/g, "''");

  // Insert into cache
  query(`INSERT INTO public.sitemap_xml_cache (page_id, xml, entry_count, generated_at) VALUES (${pageId}, '${xmlEscaped}', ${urlElements.length}, NOW()) ON CONFLICT (page_id) DO UPDATE SET xml = EXCLUDED.xml, entry_count = EXCLUDED.entry_count, generated_at = EXCLUDED.generated_at`);

  console.log(`Page ${pageId}/${totalPages - 1}: ${urlElements.length} URLs (total: ${processedTotal}/${totalEntries})`);

  if (rows.length < targetCount) {
    console.log('Reached end of entries.');
    break;
  }
}

// Reset cursor
query("INSERT INTO public.ai_settings (key, value) VALUES ('sitemap_render_page', '0') ON CONFLICT (key) DO UPDATE SET value = '0'");

console.log(`\nDone! Generated ${totalPages} sitemap pages with ${processedTotal + STATIC_URLS.length} total URLs.`);
