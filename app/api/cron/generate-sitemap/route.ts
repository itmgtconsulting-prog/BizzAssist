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
 *   Scroll-paginerer CVR ElasticSearch (Erhvervsstyrelsen) for alle aktive
 *   virksomheder. Upserts slug + CVR-nummer i batches af 200 per scroll-side.
 *
 * Phase: properties
 *   Paginerer DAWA adgangsadresser (1000 pr. side, max 20 sider pr. kørsel).
 *   Gemmer fremskridt i public.ai_settings med nøglen 'sitemap_dawa_page'
 *   så næste kørsel kan fortsætte hvor den slap.
 *   Skipper adresser uden bfenummer.
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
import { generateEjendomSlug, generateVirksomhedSlug } from '@/app/lib/slug';
import { safeCompare } from '@/lib/safeCompare';

// ─── Konstanter ────────────────────────────────────────────────────────────────

/** Antal virksomheder pr. CVR ES scroll-side */
const CVR_SCROLL_SIZE = 500;

/** Antal adresser pr. DAWA-side (max 1000) */
const DAWA_PAGE_SIZE = 1_000;

/** Max antal DAWA-sider pr. kørsel (beskytter mod Vercel 10s timeout) */
const MAX_DAWA_PAGES_PER_RUN = 20;

/** Antal rækker der upserts til Supabase ad gangen */
const UPSERT_BATCH_SIZE = 200;

/** Supabase ai_settings nøgle til DAWA-side fremskridt */
const DAWA_PROGRESS_KEY = 'sitemap_dawa_page';

/** CVR ES scroll TTL */
const CVR_SCROLL_TTL = '2m';

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

/** CVR ES scroll-svar */
interface CvrScrollResponse {
  _scroll_id?: string;
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
    }>;
  };
}

/** DAWA adgangsadresse (nestet struktur) — kun de felter vi bruger */
interface DawaAdgangsadresse {
  vejstykke?: { navn?: string };
  husnr?: string;
  postnummer?: { nr?: string; navn?: string };
  jordstykke?: { bfenummer?: number | null };
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
    console.error('[generate-sitemap] Upsert fejl:', error.message);
    return 0;
  }

  return batch.length;
}

// ─── Phase: companies ──────────────────────────────────────────────────────────

/**
 * Scroll-paginerer CVR ElasticSearch og upserts alle aktive virksomheder
 * til sitemap_entries. Bruger Erhvervsstyrelsens Basic Auth credentials.
 *
 * Stopper automatisk når scroll returnerer tom hits-array.
 *
 * @param admin - Supabase admin client til DB-writes
 * @returns Antal virksomheder der blev upserted
 */
async function phaseCompanies(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ count: number }> {
  const cvrUser = process.env.CVR_ES_USER ?? '';
  const cvrPass = process.env.CVR_ES_PASS ?? '';

  if (!cvrUser || !cvrPass) {
    return { count: 0 };
  }

  const authHeader = `Basic ${Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64')}`;
  const now = new Date().toISOString();
  let totalCount = 0;
  let scrollId: string | undefined;

  // Initial scroll-request
  const initialQuery = {
    size: CVR_SCROLL_SIZE,
    query: {
      bool: {
        must: [{ term: { 'Vrvirksomhed.reklamebeskyttet': false } }],
        must_not: [{ exists: { field: 'Vrvirksomhed.livsforloeb.periode.gyldigTil' } }],
      },
    },
    _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn'],
  };

  try {
    const initRes = await fetch(
      `https://distribution.virk.dk/cvr-permanent/virksomhed/_search?scroll=${CVR_SCROLL_TTL}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify(initialQuery),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!initRes.ok) {
      console.error('[generate-sitemap] CVR ES initial request fejlede:', initRes.status);
      return { count: 0 };
    }

    const initData = (await initRes.json()) as CvrScrollResponse;
    scrollId = initData._scroll_id;

    // Behandl første side
    const firstHits = initData.hits?.hits ?? [];
    if (firstHits.length > 0) {
      const batch = buildVirksomhedBatch(firstHits, now);
      totalCount += await upsertBatch(admin, batch);
    }

    if (firstHits.length === 0 || !scrollId) {
      return { count: totalCount };
    }
  } catch (err) {
    console.error('[generate-sitemap] CVR ES initial scroll fejl:', err);
    return { count: 0 };
  }

  // Fortsæt scroll-loop
  while (scrollId) {
    try {
      const scrollRes = await fetch('https://distribution.virk.dk/_search/scroll', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({ scroll: CVR_SCROLL_TTL, scroll_id: scrollId }),
        signal: AbortSignal.timeout(10000),
      });

      if (!scrollRes.ok) {
        console.error('[generate-sitemap] CVR ES scroll request fejlede:', scrollRes.status);
        break;
      }

      const scrollData = (await scrollRes.json()) as CvrScrollResponse;
      const hits = scrollData.hits?.hits ?? [];

      // Tom hits = ingen flere resultater
      if (hits.length === 0) break;

      scrollId = scrollData._scroll_id;

      const batch = buildVirksomhedBatch(hits, now);
      totalCount += await upsertBatch(admin, batch);
    } catch (err) {
      console.error('[generate-sitemap] CVR ES scroll loop fejl:', err);
      break;
    }
  }

  return { count: totalCount };
}

/**
 * Bygger en SitemapUpsert-batch fra CVR ES hits.
 *
 * @param hits - Array af CVR ES hit-objekter
 * @param updatedAt - ISO-tidsstempel for updated_at-feltet
 * @returns Array af SitemapUpsert klar til upsert
 */
function buildVirksomhedBatch(
  hits: NonNullable<CvrScrollResponse['hits']>['hits'],
  updatedAt: string
): SitemapUpsert[] {
  const batch: SitemapUpsert[] = [];

  for (const hit of hits ?? []) {
    const vvs = hit._source?.Vrvirksomhed;
    const cvr = vvs?.cvrNummer;
    const navn = vvs?.virksomhedMetadata?.nyesteNavn?.navn;

    if (!cvr || !navn) continue;

    batch.push({
      type: 'virksomhed',
      slug: generateVirksomhedSlug(navn),
      entity_id: String(cvr),
      updated_at: updatedAt,
    });

    // Flush delbatch ved grænse for at holde memory-forbrug lavt
    if (batch.length >= UPSERT_BATCH_SIZE) {
      break; // Returnér batch — outer loop kalder upsertBatch
    }
  }

  return batch;
}

// ─── Phase: properties ─────────────────────────────────────────────────────────

/**
 * Paginerer DAWA adgangsadresser og upserts ejendomme til sitemap_entries.
 * Gemmer sidefremskridt i public.ai_settings for at kunne fortsætte
 * ved næste kørsel (Vercel 10s timeout begrænser til MAX_DAWA_PAGES_PER_RUN sider).
 *
 * Når DAWA returnerer tom side, nulstilles fremskridt til 0 (fuld scan afsluttet).
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
    .eq('key', DAWA_PROGRESS_KEY)
    .maybeSingle();

  // Supabase returns unknown row shape — extract value safely via index access.
  const progressValue = (progressRow as Record<string, unknown> | null)?.['value'];
  let startPage: number = progressValue != null ? Number(progressValue) : 1;
  if (startPage < 1) startPage = 1;

  const now = new Date().toISOString();
  let totalCount = 0;
  let currentPage = startPage;
  let done = false;

  for (let i = 0; i < MAX_DAWA_PAGES_PER_RUN; i++) {
    const url =
      `https://api.dataforsyningen.dk/adgangsadresser` +
      `?struktur=nestet&per_side=${DAWA_PAGE_SIZE}&side=${currentPage}`;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        console.error('[generate-sitemap] DAWA side', currentPage, 'fejlede:', res.status);
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

      if (data.length < DAWA_PAGE_SIZE) {
        // Kortere side = sidste side i datasættet
        await saveProgress(admin, 1);
        done = true;
        break;
      }
    } catch (err) {
      console.error('[generate-sitemap] DAWA side', currentPage, 'fejl:', err);
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
 * Bygger SitemapUpsert-entries fra DAWA adgangsadresser.
 * Skipper adresser uden bfenummer.
 *
 * @param data - Array af DAWA adgangsadresse-objekter (nestet struktur)
 * @param updatedAt - ISO-tidsstempel for updated_at-feltet
 * @returns Filtreret array af SitemapUpsert klar til upsert
 */
function buildEjendomEntries(data: unknown[], updatedAt: string): SitemapUpsert[] {
  const entries: SitemapUpsert[] = [];

  for (const item of data) {
    const a = item as DawaAdgangsadresse;

    const bfe = a.jordstykke?.bfenummer;
    if (!bfe) continue; // Skip adresser uden BFE

    const vejnavn = a.vejstykke?.navn ?? '';
    const husnr = a.husnr ?? '';
    const postnr = a.postnummer?.nr ?? '';
    const postnrnavn = a.postnummer?.navn ?? '';

    if (!vejnavn || !postnr) continue; // Skip ufuldstændige adresser

    entries.push({
      type: 'ejendom',
      slug: generateEjendomSlug(vejnavn, husnr, postnr, postnrnavn),
      entity_id: String(bfe),
      updated_at: updatedAt,
    });
  }

  return entries;
}

/**
 * Gemmer DAWA-sidefremskridt i public.ai_settings.
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
    .upsert({ key: DAWA_PROGRESS_KEY, value: page }, { onConflict: 'key' });
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
      return NextResponse.json({ ok: true, phase: 'companies', count: result.count });
    } catch (err) {
      console.error('[generate-sitemap] companies phase uventet fejl:', err);
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
    console.error('[generate-sitemap] properties phase uventet fejl:', err);
    return NextResponse.json({ error: 'Intern fejl' }, { status: 500 });
  }
}
