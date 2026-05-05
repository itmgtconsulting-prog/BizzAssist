/**
 * Cron: Generate sitemap entries — /api/cron/generate-sitemap
 *
 * Bygger og vedligeholder `public.sitemap_entries`-tabellen med alle
 * danske ejendomme og virksomheder til SEO-sitemap.
 *
 * Kør via ?phase=companies, ?phase=properties eller ?phase=vp-properties
 *
 * Phase: companies (DB-first — BIZZ-680)
 *   Paginerer `public.cvr_virksomhed`-tabellen (2.1M virksomheder) via
 *   cursor-baseret pagination sorteret på cvr. Behandler CVR_BATCH_SIZE
 *   virksomheder pr. kørsel og gemmer cursor i public.ai_settings.
 *   Markant hurtigere end den tidligere CVR ES-paginering (200/dag → 50K/kørsel).
 *
 * Phase: properties (DB-first — BIZZ-680)
 *   Paginerer `public.ejf_ejerskab`-tabellen (7.6M records) for distinkte
 *   BFE-numre. Behandler PROPERTY_BATCH_SIZE BFE'er pr. kørsel med
 *   cursor-baseret pagination. Slug genereres fra BFE-nummer (dekorativ) —
 *   vp-properties-fasen beriger efterfølgende med rigtige adresse-slugs.
 *
 * Phase: vp-properties (adresse-enrichment)
 *   Paginerer Vurderingsportalen ElasticSearch for at berige sitemap-entries
 *   med rigtige adresse-slugs (vejnavn + husnr + postnr + by). Dækker også
 *   ejerlejligheder der evt. mangler fra properties-fasen.
 *
 * Sikring:
 *   - Kræver Authorization: Bearer <CRON_SECRET>
 *   - I production: kræver også x-vercel-cron: 1
 *
 * Trigger:
 *   - Vercel Cron: se vercel.json for schedule
 *   - Manuel: GET /api/cron/generate-sitemap?phase=companies|properties|vp-properties
 *
 * @module api/cron/generate-sitemap
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateSlug, generateVirksomhedSlug } from '@/app/lib/slug';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

// ─── Konstanter ────────────────────────────────────────────────────────────────

/** Eksplicit maxDuration = 300s (5 min) — max på Vercel Pro */
export const maxDuration = 300;

/** Root URL for sitemap URLs (trimmed defensively). */
const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk')
  .trim()
  .replace(/\/$/, '');

/** Antal virksomheder pr. DB-batch.
 * Supabase PostgREST capper ved 1000 rækker per request uanset .limit().
 * Sæt til 1000 så done-check (rows.length < BATCH_SIZE) virker korrekt.
 */
const CVR_BATCH_SIZE = 1_000;

/** Antal BFE-rækker pr. DB-batch (PostgREST 1000-row cap) */
const PROPERTY_BATCH_SIZE = 1_000;

/** Pagination size — max 50k URLs per sitemap file (Google limit). */
const PAGE_SIZE = 50_000;

/** Stop ved ~4 min for at undgå at Vercel 300s timeout dræber os mid-batch. */
const SAFETY_BUDGET_MS = 240_000;

/** Antal rækker der upserts til Supabase ad gangen */
const UPSERT_BATCH_SIZE = 500;

/** Supabase ai_settings nøgle til sidst behandlede cvrNummer */
const CVR_PROGRESS_KEY = 'sitemap_cvr_after';

/** Supabase ai_settings nøgle til sidst behandlede BFE-nummer */
const PROPERTY_PROGRESS_KEY = 'sitemap_bfe_after';

/** Vurderingsportalen ES endpoint */
const VP_ES_URL = 'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search';

/** Antal BFE'er pr. VP ES request — VP ES tillader op til 10.000 per request,
 * men 1000 er en god balance mellem throughput og stabilitet. */
const VP_PAGE_SIZE = 1_000;

/** Supabase ai_settings nøgle til VP search_after-cursor */
const VP_PROGRESS_KEY = 'sitemap_vp_after';

/** Supabase ai_settings nøgle til render-xml cursor (sidst renderede page_id) */
const RENDER_XML_PROGRESS_KEY = 'sitemap_render_page';

// ─── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Verificerer at anmodningen er autoriseret via CRON_SECRET.
 * I production kræves desuden Vercels interne x-vercel-cron header.
 *
 * @param request - Indgående Next.js request
 * @returns true hvis autoriseret, ellers false
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

// ─── Types ─────────────────────────────────────────────────────────────────────

/** En enkelt entry der upserts til sitemap_entries */
interface SitemapUpsert {
  type: 'ejendom' | 'virksomhed';
  slug: string;
  entity_id: string;
  updated_at: string;
}

/** VP ES hit — kun de felter vi bruger fra preliminaryproperties-indekset */
interface VpEsHit {
  _source?: {
    bfeNumbers?: string | number | null;
    address?: string | null;
    floor?: string | null;
    door?: string | null;
  };
  /** ES sort-values til search_after-paginering */
  sort?: unknown[];
}

/** VP ES response */
interface VpEsResponse {
  hits?: {
    hits?: VpEsHit[];
  };
}

// ─── Upsert helper ─────────────────────────────────────────────────────────────

/**
 * Upserts en batch af sitemap-entries til Supabase.
 * Konflikter på (type, entity_id) opdaterer slug og updated_at.
 *
 * @param admin - Supabase admin client
 * @param batch - Array af entries der skal upserts
 * @returns Antal rækker der blev upserted
 */
async function upsertBatch(
  admin: ReturnType<typeof createAdminClient>,
  batch: SitemapUpsert[]
): Promise<number> {
  if (batch.length === 0) return 0;

  const { error } = await admin.from('sitemap_entries').upsert(batch, {
    onConflict: 'type,entity_id',
  });

  if (error) {
    logger.error('[generate-sitemap] Upsert fejl:', error.message);
    return 0;
  }

  return batch.length;
}

// ─── Progress helpers ─────────────────────────────────────────────────────────

/**
 * Henter en cursor-værdi fra ai_settings.
 *
 * @param admin - Supabase admin client
 * @param key - ai_settings nøgle
 * @returns Gemt værdi som string, eller null hvis ikke sat
 */
async function getProgress(
  admin: ReturnType<typeof createAdminClient>,
  key: string
): Promise<string | null> {
  const { data } = await admin.from('ai_settings').select('value').eq('key', key).maybeSingle();
  const val = (data as Record<string, unknown> | null)?.['value'];
  return val != null ? String(val) : null;
}

/**
 * Gemmer en cursor-værdi i ai_settings.
 *
 * @param admin - Supabase admin client
 * @param key - ai_settings nøgle
 * @param value - Cursor-værdi (string/number/null)
 */
async function saveProgress(
  admin: ReturnType<typeof createAdminClient>,
  key: string,
  value: string | number | null
): Promise<void> {
  await admin.from('ai_settings').upsert({ key, value: value ?? 0 }, { onConflict: 'key' });
}

// ─── Phase: companies (DB-first) ──────────────────────────────────────────────

/**
 * Paginerer cvr_virksomhed-tabellen via cursor-baseret pagination.
 * Behandler CVR_BATCH_SIZE virksomheder per loop-iteration og kører
 * op til SAFETY_BUDGET_MS (4 min) inden for én cron-invokation.
 *
 * BIZZ-680: Erstatter den tidligere CVR ES-paginering (200/dag) med
 * direkte DB-reads (50K+ per kørsel). Fuld backfill af 2.1M virksomheder
 * kan afsluttes på ~40 cron-kørsler i stedet for 10.500.
 *
 * @param admin - Supabase admin client til DB-reads og writes
 * @returns Antal virksomheder upserted, sidst behandlede CVR, og om scan er afsluttet
 */
async function phaseCompanies(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ count: number; lastCvr: string; done: boolean }> {
  const cursor = await getProgress(admin, CVR_PROGRESS_KEY);
  let afterCvr = cursor ?? '0';
  const now = new Date().toISOString();
  const runStart = Date.now();
  let totalCount = 0;

  while (Date.now() - runStart < SAFETY_BUDGET_MS) {
    // Hent næste batch fra cvr_virksomhed sorteret på cvr (PK)
    // Tabellen er ikke i genererede Supabase-typer — cast manuelt.
    const { data, error } = await admin
      .from('cvr_virksomhed' as 'sitemap_entries')
      .select('cvr, navn')
      .gt('cvr', afterCvr)
      .not('navn', 'is', null)
      .order('cvr', { ascending: true })
      .limit(CVR_BATCH_SIZE);

    if (error) {
      logger.error('[generate-sitemap] DB-read cvr_virksomhed fejl:', error.message);
      break;
    }

    const rows = data as unknown as Array<{ cvr: string; navn: string }> | null;
    if (!rows || rows.length === 0) {
      // Alle virksomheder processeret — nulstil cursor
      await saveProgress(admin, CVR_PROGRESS_KEY, '0');
      return { count: totalCount, lastCvr: afterCvr, done: true };
    }

    // Byg sitemap-entries fra DB-rækker
    const batch: SitemapUpsert[] = [];
    for (const row of rows) {
      if (!row.cvr || !row.navn) continue;
      batch.push({
        type: 'virksomhed',
        slug: generateVirksomhedSlug(row.navn),
        entity_id: row.cvr,
        updated_at: now,
      });
    }

    // Upsert i sub-batches
    let batchStart = 0;
    while (batchStart < batch.length) {
      const slice = batch.slice(batchStart, batchStart + UPSERT_BATCH_SIZE);
      totalCount += await upsertBatch(admin, slice);
      batchStart += UPSERT_BATCH_SIZE;
    }

    // Avancer cursor til sidst sete CVR
    afterCvr = rows[rows.length - 1].cvr;
    await saveProgress(admin, CVR_PROGRESS_KEY, afterCvr);

    // Kortere side = sidste batch
    if (rows.length < CVR_BATCH_SIZE) {
      await saveProgress(admin, CVR_PROGRESS_KEY, '0');
      return { count: totalCount, lastCvr: afterCvr, done: true };
    }
  }

  return { count: totalCount, lastCvr: afterCvr, done: false };
}

// ─── Phase: properties (DB-first) ─────────────────────────────────────────────

/**
 * Paginerer ejf_ejerskab-tabellen for distinkte BFE-numre og upserts
 * ejendomme til sitemap_entries.
 *
 * BIZZ-680: Erstatter den tidligere DAWA-paginering (25K cap per kommune)
 * med direkte DB-reads fra ejf_ejerskab (7.6M records). Alle ejendomme
 * med ejerskab — inkl. ejerlejligheder — dækkes automatisk.
 *
 * Slug genereres som `ejendom-{bfe}` (placeholder). vp-properties-fasen
 * beriger efterfølgende med rigtige adresse-slugs fra Vurderingsportalen.
 *
 * @param admin - Supabase admin client
 * @returns Antal upserted, sidst behandlede BFE, og om scan er afsluttet
 */
async function phaseProperties(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ count: number; lastBfe: string; done: boolean }> {
  const cursor = await getProgress(admin, PROPERTY_PROGRESS_KEY);
  let afterBfe = cursor && cursor !== '0' ? Number(cursor) : 0;
  const now = new Date().toISOString();
  const runStart = Date.now();
  let totalCount = 0;

  while (Date.now() - runStart < SAFETY_BUDGET_MS) {
    // Hent BFE-numre fra ejf_ejerskab via cursor-pagination.
    // ejf_ejerskab har indeks på bfe_nummer — returnerer mange rows per BFE
    // (én per ejer), så vi deduplicerer client-side.
    // Tabellen er ikke i genererede Supabase-typer — cast manuelt.
    const { data, error } = await admin
      .from('ejf_ejerskab' as 'sitemap_entries')
      .select('bfe_nummer')
      .gt('bfe_nummer', afterBfe)
      .order('bfe_nummer', { ascending: true })
      .limit(PROPERTY_BATCH_SIZE);

    if (error) {
      logger.error('[generate-sitemap] DB-read ejf_ejerskab fejl:', error.message);
      break;
    }

    const rows = data as unknown as Array<{ bfe_nummer: number }> | null;
    if (!rows || rows.length === 0) {
      await saveProgress(admin, PROPERTY_PROGRESS_KEY, '0');
      return { count: totalCount, lastBfe: String(afterBfe), done: true };
    }

    // Dedup BFE-numre (ejf_ejerskab kan have flere ejere per BFE)
    const uniqueBfes: number[] = [];
    let prevBfe = 0;
    for (const row of rows) {
      const bfe = row.bfe_nummer;
      if (bfe && bfe !== prevBfe) {
        uniqueBfes.push(bfe);
        prevBfe = bfe;
      }
    }

    // Byg sitemap-entries med placeholder-slug (beriges af vp-properties)
    const batch: SitemapUpsert[] = uniqueBfes.map((bfe) => ({
      type: 'ejendom' as const,
      slug: `ejendom-${bfe}`,
      entity_id: String(bfe),
      updated_at: now,
    }));

    // Upsert i sub-batches
    let batchStart = 0;
    while (batchStart < batch.length) {
      const slice = batch.slice(batchStart, batchStart + UPSERT_BATCH_SIZE);
      totalCount += await upsertBatch(admin, slice);
      batchStart += UPSERT_BATCH_SIZE;
    }

    // Avancer cursor til sidst sete BFE (fra rå rows, ikke deduped)
    afterBfe = rows[rows.length - 1].bfe_nummer as number;
    await saveProgress(admin, PROPERTY_PROGRESS_KEY, String(afterBfe));

    // Hvis vi fik færre end PROPERTY_BATCH_SIZE er vi færdige
    if (rows.length < PROPERTY_BATCH_SIZE) {
      await saveProgress(admin, PROPERTY_PROGRESS_KEY, '0');
      return { count: totalCount, lastBfe: String(afterBfe), done: true };
    }
  }

  return { count: totalCount, lastBfe: String(afterBfe), done: false };
}
// ─── Phase: vp-properties (slug-enrichment) ─────────────────────────��───────

/**
 * Paginerer Vurderingsportalen ElasticSearch og beriger sitemap_entries
 * med rigtige adresse-slugs (vejnavn + husnr + postnr + by).
 *
 * BIZZ-680: Denne fase fungerer nu som slug-enrichment oven på properties-fasen
 * (som bulk-inserter med placeholder-slugs fra ejf_ejerskab). VP ES indeholder
 * address-felter for alle BFE-numre inkl. ejerlejligheder. Upsert-on-conflict
 * opdaterer slug + updated_at for eksisterende entries.
 *
 * Kører i loop op til SAFETY_BUDGET_MS med VP_PAGE_SIZE per ES-request.
 *
 * @param admin - Supabase admin client til DB-writes og fremskridt
 * @returns Antal upserted BFE'er, sidst sete BFE og om scan er afsluttet
 */
async function phaseVpProperties(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ count: number; lastBfe: string | null; done: boolean }> {
  const cursor = await getProgress(admin, VP_PROGRESS_KEY);
  let afterBfe: string | null = cursor && cursor !== '0' ? cursor : null;
  const runStart = Date.now();
  let totalCount = 0;

  while (Date.now() - runStart < SAFETY_BUDGET_MS) {
    // Byg search_after query — sorteret på bfeNumbers for stateless paginering
    const query: Record<string, unknown> = {
      size: VP_PAGE_SIZE,
      sort: [{ bfeNumbers: 'asc' }],
      query: { match_all: {} },
      _source: ['bfeNumbers', 'address', 'floor', 'door'],
      ...(afterBfe != null ? { search_after: [afterBfe] } : {}),
    };

    let hits: VpEsHit[] = [];

    try {
      const res = await fetch(VP_ES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        logger.error('[generate-sitemap] VP ES request fejlede:', res.status);
        break;
      }

      const data = (await res.json()) as VpEsResponse;
      hits = data.hits?.hits ?? [];
    } catch (err) {
      logger.error('[generate-sitemap] VP ES request fejl:', err);
      break;
    }

    if (hits.length === 0) {
      await saveProgress(admin, VP_PROGRESS_KEY, null);
      return { count: totalCount, lastBfe: null, done: true };
    }

    const now = new Date().toISOString();
    const batch: SitemapUpsert[] = [];
    let newLastBfe: string | null = afterBfe;

    for (const hit of hits) {
      const s = hit._source;
      const bfe = s?.bfeNumbers;
      if (!bfe) continue;

      const bfeStr = String(bfe);
      const address = s.address ? String(s.address).trim() : '';
      const floor = s.floor ? String(s.floor).trim() : '';
      const door = s.door ? String(s.door).trim() : '';

      if (!address) continue;

      const slugParts = [address, floor, door].filter(Boolean).join(' ');

      batch.push({
        type: 'ejendom',
        slug: generateSlug(slugParts),
        entity_id: bfeStr,
        updated_at: now,
      });

      const sortCursor = hit.sort?.[0];
      newLastBfe = sortCursor != null ? String(sortCursor) : bfeStr;
    }

    // Upsert i sub-batches — on-conflict opdaterer slug til rigtig adresse
    let batchStart = 0;
    while (batchStart < batch.length) {
      const slice = batch.slice(batchStart, batchStart + UPSERT_BATCH_SIZE);
      totalCount += await upsertBatch(admin, slice);
      batchStart += UPSERT_BATCH_SIZE;
    }

    afterBfe = newLastBfe;
    if (newLastBfe) {
      await saveProgress(admin, VP_PROGRESS_KEY, newLastBfe);
    }

    // Kortere side = sidste side i datasættet
    if (hits.length < VP_PAGE_SIZE) {
      await saveProgress(admin, VP_PROGRESS_KEY, null);
      return { count: totalCount, lastBfe: newLastBfe, done: true };
    }
  }

  return { count: totalCount, lastBfe: afterBfe, done: false };
}

// ─── Phase: render-xml (pre-generate static XML) ────────────────────────────

/**
 * Escape XML special characters in URL values.
 *
 * @param s - Raw string to escape
 * @returns XML-safe string
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Serialize a single URL entry to XML.
 *
 * @param loc - Full URL
 * @param lastmod - ISO date string (YYYY-MM-DD)
 * @param changefreq - Sitemap changefreq value
 * @param priority - Sitemap priority (0.0–1.0)
 * @returns XML <url> element string
 */
function serializeUrl(loc: string, lastmod: string, changefreq: string, priority: number): string {
  return `<url><loc>${xmlEscape(loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority.toFixed(1)}</priority></url>`;
}

/**
 * Static pages included in sitemap page 0.
 *
 * @returns Array of XML <url> strings
 */
function staticPageUrls(): string[] {
  const today = new Date().toISOString().split('T')[0];
  return [
    serializeUrl(`${BASE_URL}/`, today, 'weekly', 1.0),
    serializeUrl(`${BASE_URL}/privacy`, today, 'yearly', 0.2),
    serializeUrl(`${BASE_URL}/terms`, today, 'yearly', 0.2),
    serializeUrl(`${BASE_URL}/cookies`, today, 'yearly', 0.1),
  ];
}

/**
 * Wrap URL entries in a complete XML sitemap document.
 *
 * @param urlElements - Array of <url>...</url> strings
 * @returns Complete XML sitemap string
 */
function wrapSitemap(urlElements: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urlElements.join('\n') +
    `\n</urlset>\n`
  );
}

/**
 * Pre-renders sitemap XML files from sitemap_entries and stores them
 * in sitemap_xml_cache for instant serving to Google's crawler.
 *
 * Processes one page (up to 50K URLs) per iteration within the safety
 * budget. Each page reads from sitemap_entries in 1000-row chunks
 * (PostgREST cap), builds the XML string, and upserts it into
 * sitemap_xml_cache.
 *
 * BIZZ-890: Fixes Google indexing — the on-demand /sitemap/[id] route
 * timed out (>60s) because it ran 50 sequential DB queries per request.
 * Pre-rendering moves that work to a cron job; the route then serves
 * a single cached row.
 *
 * @param admin - Supabase admin client
 * @returns Pages rendered, total entries, and whether all pages are done
 */
async function phaseRenderXml(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ pagesRendered: number; totalEntries: number; done: boolean }> {
  // Count total entries to determine number of pages
  const { count: totalCount } = await admin
    .from('sitemap_entries')
    .select('*', { count: 'exact', head: true });

  const STATIC_COUNT = 4; // static pages on page 0
  const total = (totalCount ?? 0) + STATIC_COUNT;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Resume from last rendered page
  const cursor = await getProgress(admin, RENDER_XML_PROGRESS_KEY);
  let startPage = cursor && cursor !== '0' ? parseInt(cursor, 10) : 0;
  if (startPage >= totalPages) startPage = 0; // wrap around

  const runStart = Date.now();
  let pagesRendered = 0;

  for (let pageId = startPage; pageId < totalPages; pageId++) {
    if (Date.now() - runStart > SAFETY_BUDGET_MS) break;

    const urlElements: string[] = [];

    // Page 0 includes static pages
    if (pageId === 0) {
      urlElements.push(...staticPageUrls());
    }

    // Calculate DB offset and limit for this page
    const staticOnThisPage = pageId === 0 ? STATIC_COUNT : 0;
    const dbLimit = PAGE_SIZE - staticOnThisPage;
    const dbOffset = pageId === 0 ? 0 : pageId * PAGE_SIZE - STATIC_COUNT;

    // Read entries in 1000-row chunks (PostgREST cap)
    const CHUNK = 1000;
    let chunkCursor = dbOffset;
    const endExclusive = dbOffset + dbLimit;

    while (chunkCursor < endExclusive) {
      if (Date.now() - runStart > SAFETY_BUDGET_MS) break;

      const chunkEnd = Math.min(chunkCursor + CHUNK - 1, endExclusive - 1);
      const { data, error } = await admin
        .from('sitemap_entries')
        .select('type, slug, entity_id, updated_at')
        .order('updated_at', { ascending: false })
        .range(chunkCursor, chunkEnd);

      if (error) {
        logger.error('[generate-sitemap] render-xml DB read error:', error.message);
        break;
      }

      const rows = data ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const loc =
          row.type === 'ejendom'
            ? `${BASE_URL}/ejendom/${row.slug}/${row.entity_id}`
            : `${BASE_URL}/virksomhed/${row.slug}/${row.entity_id}`;
        const lastmod = new Date(row.updated_at).toISOString().split('T')[0];
        const priority = row.type === 'virksomhed' ? 0.8 : 0.7;
        urlElements.push(serializeUrl(loc, lastmod, 'monthly', priority));
      }

      if (rows.length < CHUNK) break;
      chunkCursor += CHUNK;
    }

    // Build and store XML
    const xml = wrapSitemap(urlElements);

    const { error: upsertErr } = await admin.from('sitemap_xml_cache').upsert(
      {
        page_id: pageId,
        xml,
        entry_count: urlElements.length,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'page_id' }
    );

    if (upsertErr) {
      logger.error(`[generate-sitemap] render-xml upsert page ${pageId} error:`, upsertErr.message);
      break;
    }

    pagesRendered++;
    await saveProgress(admin, RENDER_XML_PROGRESS_KEY, String(pageId + 1));
    logger.log(
      `[generate-sitemap] render-xml page ${pageId}/${totalPages - 1}: ${urlElements.length} URLs`
    );
  }

  // Check if we rendered all pages
  const nextPage = startPage + pagesRendered;
  const done = nextPage >= totalPages;
  if (done) {
    // Clean up stale cache pages (from previous runs with more entries)
    await admin.from('sitemap_xml_cache').delete().gte('page_id', totalPages);
    await saveProgress(admin, RENDER_XML_PROGRESS_KEY, '0');
  }

  return { pagesRendered, totalEntries: total, done };
}

// ─── Route handler ─────────────────────────────────────────────────────────────

/**
 * GET /api/cron/generate-sitemap?phase=companies|properties|vp-properties
 *
 * Kræver:
 *   - Authorization: Bearer <CRON_SECRET>
 *   - x-vercel-cron: 1 (kun i production)
 *
 * Query params:
 *   - phase: 'companies' | 'properties' | 'vp-properties' (påkrævet)
 *
 * @param request - Indgående Next.js request med Authorization header og phase query param
 * @returns JSON-respons med fase, antal upserted og status
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const phase = searchParams.get('phase');

  if (
    phase !== 'companies' &&
    phase !== 'properties' &&
    phase !== 'vp-properties' &&
    phase !== 'render-xml'
  ) {
    return NextResponse.json(
      {
        error:
          'Ugyldig phase — brug ?phase=companies, ?phase=properties, ?phase=vp-properties eller ?phase=render-xml',
      },
      { status: 400 }
    );
  }

  const phaseConfig = {
    companies: { schedule: '23 * * * *' },
    properties: { schedule: '30 * * * *' },
    'vp-properties': { schedule: '51 * * * *' },
    'render-xml': { schedule: '10 * * * *' },
  }[phase];

  // companies + properties kører hourly for hurtig backfill; vp-properties dagligt; render-xml hourly
  const intervalMinutes = phase === 'vp-properties' ? 1440 : 60;

  return withCronMonitor(
    {
      jobName: `generate-sitemap-${phase}`,
      schedule: phaseConfig.schedule,
      intervalMinutes,
    },
    async () => {
      const admin = createAdminClient();

      if (phase === 'companies') {
        try {
          const result = await phaseCompanies(admin);
          return NextResponse.json({
            ok: true,
            phase: 'companies',
            count: result.count,
            lastCvr: result.lastCvr,
            done: result.done,
          });
        } catch (err) {
          logger.error('[generate-sitemap] companies phase uventet fejl:', err);
          return NextResponse.json({ error: 'Intern fejl' }, { status: 500 });
        }
      }

      if (phase === 'render-xml') {
        try {
          const result = await phaseRenderXml(admin);
          return NextResponse.json({
            ok: true,
            phase: 'render-xml',
            pagesRendered: result.pagesRendered,
            totalEntries: result.totalEntries,
            done: result.done,
          });
        } catch (err) {
          logger.error('[generate-sitemap] render-xml phase uventet fejl:', err);
          return NextResponse.json({ error: 'Intern fejl' }, { status: 500 });
        }
      }

      if (phase === 'vp-properties') {
        try {
          const result = await phaseVpProperties(admin);
          return NextResponse.json({
            ok: true,
            phase: 'vp-properties',
            count: result.count,
            lastBfe: result.lastBfe,
            done: result.done,
          });
        } catch (err) {
          logger.error('[generate-sitemap] vp-properties phase uventet fejl:', err);
          return NextResponse.json({ error: 'Intern fejl' }, { status: 500 });
        }
      }

      // phase === 'properties'
      try {
        const result = await phaseProperties(admin);
        return NextResponse.json({
          ok: true,
          phase: 'properties',
          count: result.count,
          lastBfe: result.lastBfe,
          done: result.done,
        });
      } catch (err) {
        logger.error('[generate-sitemap] properties phase uventet fejl:', err);
        return NextResponse.json({ error: 'Intern fejl' }, { status: 500 });
      }
    }
  );
}
