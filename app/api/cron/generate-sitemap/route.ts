/**
 * Cron: Generate sitemap entries — /api/cron/generate-sitemap
 *
 * Bygger og vedligeholder `public.sitemap_entries`-tabellen med alle
 * danske ejendomme og virksomheder til SEO-sitemap.
 *
 * Kør via ?phase=companies eller ?phase=properties (ét ad gangen for
 * at holde sig under Vercels 10-sekunders function timeout).
 *
 * Phase: companies
 *   Paginerer CVR ElasticSearch (Erhvervsstyrelsen) via search_after sorteret
 *   på cvrNummer. Gemmer seneste cvrNummer i public.ai_settings med nøglen
 *   'sitemap_cvr_after' så næste kørsel kan fortsætte hvor den slap.
 *   Behandler CVR_PAGE_SIZE virksomheder pr. kørsel (ét enkelt ES-request).
 *
 * Phase: properties
 *   Paginerer DAWA jordstykker (1000 pr. side, max 20 sider pr. kørsel).
 *   Hvert jordstykke indeholder bfenummer direkte — ingen DAWA adgangsadresser
 *   bruges (de indeholder ikke bfenummer i jordstykke-sub-objektet).
 *   Gemmer fremskridt i public.ai_settings med nøglen 'sitemap_jordstykke_page'
 *   så næste kørsel kan fortsætte hvor den slap.
 *   Skipper jordstykker uden bfenummer.
 *
 * Sikring:
 *   - Kræver Authorization: Bearer <CRON_SECRET>
 *   - I production: kræver også x-vercel-cron: 1
 *
 * Trigger:
 *   - Vercel Cron: søndag kl. 02:00 UTC (companies) og 03:00 UTC (properties)
 *   - Manuel: GET /api/cron/generate-sitemap?phase=companies|properties
 *
 * @module api/cron/generate-sitemap
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateSlug, generateVirksomhedSlug } from '@/app/lib/slug';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';

// ─── Konstanter ────────────────────────────────────────────────────────────────

/** Antal virksomheder pr. CVR ES request (lavt for at holde sig under Vercels 10s timeout) */
const CVR_PAGE_SIZE = 200;

/** Antal jordstykker pr. DAWA-side (max 1000) */
const JORDSTYKKE_PAGE_SIZE = 1_000;

/** Max antal DAWA-sider pr. kørsel (beskytter mod Vercel 10s timeout) */
const MAX_JORDSTYKKE_PAGES_PER_RUN = 20;

/** Antal rækker der upserts til Supabase ad gangen */
const UPSERT_BATCH_SIZE = 200;

/** Supabase ai_settings nøgle til sidst behandlede cvrNummer */
const CVR_PROGRESS_KEY = 'sitemap_cvr_after';

/** Supabase ai_settings nøgle til jordstykke-side fremskridt */
const JORDSTYKKE_PROGRESS_KEY = 'sitemap_jordstykke_page';

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

/** CVR ES response for search_after paginering */
interface CvrSearchResponse {
  hits?: {
    hits?: Array<{
      _source?: {
        Vrvirksomhed?: {
          cvrNummer?: number;
          virksomhedMetadata?: {
            nyesteNavn?: { navn?: string };
          };
        };
      };
      sort?: number[];
    }>;
  };
}

/** DAWA jordstykke — kun de felter vi bruger */
interface DawaJordstykke {
  bfenummer?: number | null;
  ejerlav?: { kode?: number; navn?: string };
  matrikelnr?: string;
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

// ─── Phase: companies ──────────────────────────────────────────────────────────

/**
 * Paginerer CVR ElasticSearch via search_after sorteret på cvrNummer.
 * Behandler CVR_PAGE_SIZE virksomheder per kørsel (ét enkelt ES-request)
 * og gemmer fremskridt i public.ai_settings for at fortsætte ved næste kørsel.
 *
 * Undgår scroll-API'et som kræver en aktiv scroll-session på tværs af kald —
 * search_after med range-query er stateless og timeout-sikkert.
 *
 * @param admin - Supabase admin client til DB-writes
 * @returns Antal virksomheder der blev upserted og om paginering er nulstillet
 */
async function phaseCompanies(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ count: number; lastCvr: number; done: boolean }> {
  const cvrUser = process.env.CVR_ES_USER ?? '';
  const cvrPass = process.env.CVR_ES_PASS ?? '';

  if (!cvrUser || !cvrPass) {
    logger.error('[generate-sitemap] CVR_ES_USER/CVR_ES_PASS mangler');
    return { count: 0, lastCvr: 0, done: false };
  }

  // Hent sidst behandlede cvrNummer fra ai_settings
  const { data: progressRow } = await admin
    .from('ai_settings')
    .select('value')
    .eq('key', CVR_PROGRESS_KEY)
    .maybeSingle();

  const progressValue = (progressRow as Record<string, unknown> | null)?.['value'];
  const afterCvr: number = progressValue != null ? Number(progressValue) : 0;

  const authHeader = `Basic ${Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64')}`;
  const now = new Date().toISOString();

  // Byg search_after query med range på cvrNummer — stateless og hurtigt
  const query: Record<string, unknown> = {
    size: CVR_PAGE_SIZE,
    sort: [{ 'Vrvirksomhed.cvrNummer': 'asc' }],
    query: {
      bool: {
        must: [
          { term: { 'Vrvirksomhed.reklamebeskyttet': false } },
          ...(afterCvr > 0 ? [{ range: { 'Vrvirksomhed.cvrNummer': { gt: afterCvr } } }] : []),
        ],
        must_not: [{ exists: { field: 'Vrvirksomhed.livsforloeb.periode.gyldigTil' } }],
      },
    },
    _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn'],
  };

  let hits: NonNullable<CvrSearchResponse['hits']>['hits'] = [];

  try {
    const res = await fetch('https://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(query),
      // 7s timeout — lader 3s til upsert + Vercel overhead inden 10s grænsen
      signal: AbortSignal.timeout(7000),
    });

    if (!res.ok) {
      logger.error('[generate-sitemap] CVR ES request fejlede:', res.status);
      return { count: 0, lastCvr: afterCvr, done: false };
    }

    const data = (await res.json()) as CvrSearchResponse;
    hits = data.hits?.hits ?? [];
  } catch (err) {
    logger.error('[generate-sitemap] CVR ES request fejl:', err);
    return { count: 0, lastCvr: afterCvr, done: false };
  }

  if (hits.length === 0) {
    // Ingen flere resultater — fuld scan afsluttet, nulstil fremskridt
    await admin
      .from('ai_settings')
      .upsert({ key: CVR_PROGRESS_KEY, value: 0 }, { onConflict: 'key' });
    return { count: 0, lastCvr: 0, done: true };
  }

  // Byg og upsert batch
  const batch: SitemapUpsert[] = [];
  let maxCvr = afterCvr;

  for (const hit of hits) {
    const vvs = hit._source?.Vrvirksomhed;
    const cvr = vvs?.cvrNummer;
    const navn = vvs?.virksomhedMetadata?.nyesteNavn?.navn;
    if (!cvr || !navn) continue;

    if (cvr > maxCvr) maxCvr = cvr;

    batch.push({
      type: 'virksomhed',
      slug: generateVirksomhedSlug(navn),
      entity_id: String(cvr),
      updated_at: now,
    });
  }

  const count = await upsertBatch(admin, batch);

  // Gem fremskridt — næste kørsel starter fra maxCvr
  if (maxCvr > afterCvr) {
    await admin
      .from('ai_settings')
      .upsert({ key: CVR_PROGRESS_KEY, value: maxCvr }, { onConflict: 'key' });
  }

  const done = hits.length < CVR_PAGE_SIZE;
  if (done) {
    // Kortere side = alle virksomheder behandlet, nulstil
    await admin
      .from('ai_settings')
      .upsert({ key: CVR_PROGRESS_KEY, value: 0 }, { onConflict: 'key' });
  }

  return { count, lastCvr: maxCvr, done };
}

// ─── Phase: properties ─────────────────────────────────────────────────────────

/**
 * Paginerer DAWA jordstykker og upserts ejendomme til sitemap_entries.
 *
 * Bruger DAWA jordstykker-endpointet (fremfor adgangsadresser) fordi
 * jordstykker indeholder bfenummer direkte. DAWA adgangsadresser?struktur=nestet
 * returnerer IKKE bfenummer i jordstykke-sub-objektet.
 *
 * Slug genereres fra ejerlav.navn + matrikelnr. Sluggen er dekorativ —
 * den offentlige ejendomsside bruger kun BFE-nummeret til datahentning.
 *
 * Gemmer sidefremskridt i public.ai_settings for at fortsætte
 * ved næste kørsel (Vercel 10s timeout begrænser til MAX_JORDSTYKKE_PAGES_PER_RUN sider).
 *
 * @param admin - Supabase admin client til DB-writes og fremskridt
 * @returns Sidetal, antal upserted og om scan er afsluttet
 */
async function phaseProperties(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ page: number; count: number; done: boolean }> {
  // Hent gemte fremskridt
  const { data: progressRow } = await admin
    .from('ai_settings')
    .select('value')
    .eq('key', JORDSTYKKE_PROGRESS_KEY)
    .maybeSingle();

  const progressValue = (progressRow as Record<string, unknown> | null)?.['value'];
  let startPage: number = progressValue != null ? Number(progressValue) : 1;
  if (startPage < 1) startPage = 1;

  const now = new Date().toISOString();
  let totalCount = 0;
  let currentPage = startPage;
  let done = false;

  for (let i = 0; i < MAX_JORDSTYKKE_PAGES_PER_RUN; i++) {
    // DAWA jordstykker returnerer bfenummer direkte — adgangsadresser gør ikke
    const url =
      `https://api.dataforsyningen.dk/jordstykker` +
      `?per_side=${JORDSTYKKE_PAGE_SIZE}&side=${currentPage}`;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        logger.error(
          '[generate-sitemap] DAWA jordstykker side',
          currentPage,
          'fejlede:',
          res.status
        );
        break;
      }

      const data = (await res.json()) as unknown[];

      if (!Array.isArray(data) || data.length === 0) {
        // Ingen flere data — fuld scan afsluttet, nulstil fremskridt
        await saveProgress(admin, 1);
        done = true;
        break;
      }

      // Byg og upsert i batches
      let batchStart = 0;
      const entries = buildEjendomEntries(data, now);

      while (batchStart < entries.length) {
        const slice = entries.slice(batchStart, batchStart + UPSERT_BATCH_SIZE);
        totalCount += await upsertBatch(admin, slice);
        batchStart += UPSERT_BATCH_SIZE;
      }

      currentPage++;

      if (data.length < JORDSTYKKE_PAGE_SIZE) {
        // Kortere side = sidste side i datasættet
        await saveProgress(admin, 1);
        done = true;
        break;
      }
    } catch (err) {
      logger.error('[generate-sitemap] DAWA jordstykker side', currentPage, 'fejl:', err);
      break;
    }
  }

  // Gem fremskridt til næste kørsel (kun hvis ikke done)
  if (!done) {
    await saveProgress(admin, currentPage);
  }

  return { page: currentPage, count: totalCount, done };
}

/**
 * Bygger SitemapUpsert-entries fra DAWA jordstykker.
 * Skipper jordstykker uden bfenummer.
 *
 * Slug genereres fra ejerlav.navn + matrikelnr da jordstykker ikke har
 * adressedata. Sluggen er dekorativ — BFE-nummeret er den funktionelle ID.
 *
 * @param data - Array af DAWA jordstykke-objekter
 * @param updatedAt - ISO-tidsstempel for updated_at-feltet
 * @returns Filtreret array af SitemapUpsert klar til upsert
 */
function buildEjendomEntries(data: unknown[], updatedAt: string): SitemapUpsert[] {
  const entries: SitemapUpsert[] = [];

  for (const item of data) {
    const js = item as DawaJordstykke;

    const bfe = js.bfenummer;
    if (!bfe) continue; // Skip jordstykker uden BFE

    // Brug ejerlav.navn + matrikelnr som slug-grundlag.
    // Sluggen er dekorativ — den offentlige side bruger kun BFE til opslag.
    const ejerlavNavn = js.ejerlav?.navn ?? String(js.ejerlav?.kode ?? '');
    const matrikelnr = js.matrikelnr ?? '';

    if (!ejerlavNavn && !matrikelnr) continue;

    entries.push({
      type: 'ejendom',
      slug: generateSlug(`${ejerlavNavn} ${matrikelnr}`),
      entity_id: String(bfe),
      updated_at: updatedAt,
    });
  }

  return entries;
}

/**
 * Gemmer jordstykke-sidefremskridt i public.ai_settings.
 * Bruges til at fortsætte ved næste cron-kørsel.
 *
 * @param admin - Supabase admin client
 * @param page - Sidetal der skal gemmes som næste startside
 */
async function saveProgress(
  admin: ReturnType<typeof createAdminClient>,
  page: number
): Promise<void> {
  await admin
    .from('ai_settings')
    .upsert({ key: JORDSTYKKE_PROGRESS_KEY, value: page }, { onConflict: 'key' });
}

// ─── Route handler ─────────────────────────────────────────────────────────────

/**
 * GET /api/cron/generate-sitemap?phase=companies|properties
 *
 * Kræver:
 *   - Authorization: Bearer <CRON_SECRET>
 *   - x-vercel-cron: 1 (kun i production)
 *
 * Query params:
 *   - phase: 'companies' | 'properties' (påkrævet)
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

  if (phase !== 'companies' && phase !== 'properties') {
    return NextResponse.json(
      { error: 'Ugyldig phase — brug ?phase=companies eller ?phase=properties' },
      { status: 400 }
    );
  }

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

  // phase === 'properties'
  try {
    const result = await phaseProperties(admin);
    return NextResponse.json({
      ok: true,
      phase: 'properties',
      page: result.page,
      count: result.count,
      done: result.done,
    });
  } catch (err) {
    logger.error('[generate-sitemap] properties phase uventet fejl:', err);
    return NextResponse.json({ error: 'Intern fejl' }, { status: 500 });
  }
}
