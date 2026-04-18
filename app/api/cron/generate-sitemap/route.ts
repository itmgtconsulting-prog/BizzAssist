/**
 * Cron: Generate sitemap entries — /api/cron/generate-sitemap
 *
 * Bygger og vedligeholder `public.sitemap_entries`-tabellen med alle
 * danske ejendomme og virksomheder til SEO-sitemap.
 *
 * Kør via ?phase=companies, ?phase=properties eller ?phase=vp-properties
 * (ét ad gangen for at holde sig under Vercels 10-sekunders function timeout).
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
 * Phase: vp-properties
 *   Paginerer Vurderingsportalen ElasticSearch (api-fs.vurderingsportalen.dk)
 *   via search_after sorteret på bfeNumbers. Dækker ALLE BFE-numre inkl.
 *   ejerlejligheder som ikke har et jordstykke i DAWA (og dermed mangler i
 *   'properties'-fasen). Behandler VP_PAGE_SIZE BFE'er pr. kørsel (ét ES-request).
 *   Gemmer search_after-cursor i public.ai_settings med nøglen 'sitemap_vp_after'.
 *   Slug bygges fra adresse + etage + dør — BFE-nummeret er den funktionelle ID.
 *
 * Sikring:
 *   - Kræver Authorization: Bearer <CRON_SECRET>
 *   - I production: kræver også x-vercel-cron: 1
 *
 * Trigger:
 *   - Vercel Cron: søndag kl. 02:00 UTC (companies), 03:00 UTC (properties),
 *     04:00 UTC (vp-properties)
 *   - Manuel: GET /api/cron/generate-sitemap?phase=companies|properties|vp-properties
 *
 * @module api/cron/generate-sitemap
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateSlug, generateVirksomhedSlug } from '@/app/lib/slug';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { fetchDawa } from '@/app/lib/dawa';
import { matListJordstykker, type MatJordstykkeBulk } from '@/app/lib/dar';

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

/** Vurderingsportalen ES endpoint — undokumenteret, men bruges af dashboard */
const VP_ES_URL = 'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search';

/** Antal BFE'er pr. VP ES request (lavt for at holde sig under Vercels 10s timeout) */
const VP_PAGE_SIZE = 500;

/** Supabase ai_settings nøgle til VP search_after-cursor (sidst sete bfeNumbers) */
const VP_PROGRESS_KEY = 'sitemap_vp_after';

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
    // BIZZ-510: Try MAT WFS (Datafordeler) first. Falls back to DAWA
    // /jordstykker until DAWA shuts down 2026-07-01. Both paths are
    // normalised to MatJordstykkeBulk[] so buildEjendomEntries handles a
    // single shape regardless of source.
    let items: MatJordstykkeBulk[] | null = null;

    try {
      const startIndex = (currentPage - 1) * JORDSTYKKE_PAGE_SIZE;
      items = await matListJordstykker(startIndex, JORDSTYKKE_PAGE_SIZE);
    } catch (err) {
      logger.error(
        '[generate-sitemap] MAT WFS side',
        currentPage,
        'kastede — falder tilbage til DAWA:',
        err
      );
    }

    if (items === null) {
      // MAT failed or unavailable — fall back to DAWA for this page only.
      try {
        const url =
          `https://api.dataforsyningen.dk/jordstykker` +
          `?per_side=${JORDSTYKKE_PAGE_SIZE}&side=${currentPage}`;
        const res = await fetchDawa(
          url,
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) },
          { caller: 'cron.generate-sitemap.jordstykker.fallback' }
        );

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
        if (!Array.isArray(data)) break;
        items = data
          .map((raw): MatJordstykkeBulk | null => {
            const js = raw as DawaJordstykke;
            const bfe = js.bfenummer;
            if (!bfe) return null;
            return {
              bfenummer: bfe,
              matrikelnr: js.matrikelnr ?? '',
              ejerlavsnavn: js.ejerlav?.navn ?? '',
              ejerlavskode: js.ejerlav?.kode ?? 0,
            };
          })
          .filter((x): x is MatJordstykkeBulk => x !== null);
      } catch (err) {
        logger.error('[generate-sitemap] DAWA jordstykker side', currentPage, 'fejl:', err);
        break;
      }
    }

    if (items.length === 0) {
      // No more data — full scan done, reset progress
      await saveProgress(admin, 1);
      done = true;
      break;
    }

    // Build + upsert in batches
    let batchStart = 0;
    const entries = buildEjendomEntries(items, now);
    while (batchStart < entries.length) {
      const slice = entries.slice(batchStart, batchStart + UPSERT_BATCH_SIZE);
      totalCount += await upsertBatch(admin, slice);
      batchStart += UPSERT_BATCH_SIZE;
    }

    currentPage++;

    if (items.length < JORDSTYKKE_PAGE_SIZE) {
      // Shorter page = last page in dataset
      await saveProgress(admin, 1);
      done = true;
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
 * BIZZ-510: Input er normaliseret MatJordstykkeBulk (flat shape), så både
 * MAT WFS og DAWA fallback mappes til samme form før upsert.
 *
 * @param data - Array af normaliserede jordstykker
 * @param updatedAt - ISO-tidsstempel for updated_at-feltet
 * @returns Filtreret array af SitemapUpsert klar til upsert
 */
function buildEjendomEntries(data: MatJordstykkeBulk[], updatedAt: string): SitemapUpsert[] {
  const entries: SitemapUpsert[] = [];

  for (const js of data) {
    if (!js.bfenummer) continue; // Skip jordstykker uden BFE

    // Brug ejerlav.navn + matrikelnr som slug-grundlag.
    // Sluggen er dekorativ — den offentlige side bruger kun BFE til opslag.
    const ejerlavNavn = js.ejerlavsnavn || String(js.ejerlavskode || '');
    const matrikelnr = js.matrikelnr;

    if (!ejerlavNavn && !matrikelnr) continue;

    entries.push({
      type: 'ejendom',
      slug: generateSlug(`${ejerlavNavn} ${matrikelnr}`),
      entity_id: String(js.bfenummer),
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

// ─── Phase: vp-properties ─────────────────────────────────────────────────────

/**
 * Paginerer Vurderingsportalen ElasticSearch og upserts ejendomme (inkl.
 * ejerlejligheder) til sitemap_entries.
 *
 * Bruger search_after-paginering sorteret på bfeNumbers — stateless og
 * timeout-sikkert på tværs af Vercel-kald. Behandler VP_PAGE_SIZE BFE'er
 * pr. kørsel (ét enkelt ES-request) og gemmer cursor i public.ai_settings.
 *
 * Denne fase supplerer 'properties'-fasen: DAWA jordstykker dækker kun
 * grund-ejendomme. Ejerlejligheder har egne BFE-numre i VP ES men intet
 * jordstykke i DAWA og ville ellers mangle i sitemappet.
 *
 * Slug bygges fra address + floor + door. BFE-nummeret er den funktionelle ID —
 * sluggen er dekorativ og bruges kun til læsbar URL.
 *
 * @param admin - Supabase admin client til DB-writes og fremskridt
 * @returns Antal upserted BFE'er, sidst sete BFE og om scan er afsluttet
 */
async function phaseVpProperties(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ count: number; lastBfe: string | null; done: boolean }> {
  // Hent search_after-cursor fra forrige kørsel
  const { data: progressRow } = await admin
    .from('ai_settings')
    .select('value')
    .eq('key', VP_PROGRESS_KEY)
    .maybeSingle();

  const progressValue = (progressRow as Record<string, unknown> | null)?.['value'];
  const afterBfe: string | null = progressValue != null ? String(progressValue) : null;

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
        // VP ES kræver en User-Agent der ligner en browser
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify(query),
      // 7s timeout — lader 3s til upsert + Vercel overhead inden 10s grænsen
      signal: AbortSignal.timeout(7000),
    });

    if (!res.ok) {
      logger.error('[generate-sitemap] VP ES request fejlede:', res.status);
      return { count: 0, lastBfe: afterBfe, done: false };
    }

    const data = (await res.json()) as VpEsResponse;
    hits = data.hits?.hits ?? [];
  } catch (err) {
    logger.error('[generate-sitemap] VP ES request fejl:', err);
    return { count: 0, lastBfe: afterBfe, done: false };
  }

  if (hits.length === 0) {
    // Ingen flere resultater — fuld scan afsluttet, nulstil cursor
    await admin
      .from('ai_settings')
      .upsert({ key: VP_PROGRESS_KEY, value: null }, { onConflict: 'key' });
    return { count: 0, lastBfe: null, done: true };
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

    // Slug bygges fra adresse + etage + dør. Sluggen er dekorativ —
    // kun BFE-nummeret bruges til datahentning på den offentlige side.
    const slugParts = [address, floor, door].filter(Boolean).join(' ');

    batch.push({
      type: 'ejendom',
      slug: generateSlug(slugParts),
      entity_id: bfeStr,
      updated_at: now,
    });

    // Brug ES sort-værdien som cursor hvis tilgængeligt, ellers BFE-streng
    const sortCursor = hit.sort?.[0];
    newLastBfe = sortCursor != null ? String(sortCursor) : bfeStr;
  }

  // Upsert i batches
  let totalCount = 0;
  let batchStart = 0;
  while (batchStart < batch.length) {
    const slice = batch.slice(batchStart, batchStart + UPSERT_BATCH_SIZE);
    totalCount += await upsertBatch(admin, slice);
    batchStart += UPSERT_BATCH_SIZE;
  }

  // Gem cursor til næste kørsel
  if (newLastBfe !== afterBfe) {
    await admin
      .from('ai_settings')
      .upsert({ key: VP_PROGRESS_KEY, value: newLastBfe }, { onConflict: 'key' });
  }

  const done = hits.length < VP_PAGE_SIZE;
  if (done) {
    // Kortere side = sidste side i datasættet, nulstil cursor
    await admin
      .from('ai_settings')
      .upsert({ key: VP_PROGRESS_KEY, value: null }, { onConflict: 'key' });
  }

  return { count: totalCount, lastBfe: newLastBfe, done };
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

  if (phase !== 'companies' && phase !== 'properties' && phase !== 'vp-properties') {
    return NextResponse.json(
      {
        error:
          'Ugyldig phase — brug ?phase=companies, ?phase=properties eller ?phase=vp-properties',
      },
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
      page: result.page,
      count: result.count,
      done: result.done,
    });
  } catch (err) {
    logger.error('[generate-sitemap] properties phase uventet fejl:', err);
    return NextResponse.json({ error: 'Intern fejl' }, { status: 500 });
  }
}
