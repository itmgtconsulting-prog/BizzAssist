/**
 * POST /api/ai/person-search/articles
 *
 * Split-endpoint til progressiv loading — søger KUN nyheder/artikler om en dansk person.
 * Del af parallelt søge-flow: kald dette endpoint sideløbende med /socials og /contacts.
 *
 * Understøtter dynamisk batching — frontend kalder gentagne gange med stigende batch-nummer
 * til alle virksomheder er søgt. Ingen max-begrænsning på antal virksomheder.
 *
 * Strategi:
 * 1. Brave Search — batch 0: personens egne artikler + virksomheder[0..4].
 *                   batch N: virksomheder[N*5..(N+1)*5].
 * 2. Claude — rangerer og filtrerer resultater med confidence-scoring
 * 3. Supabase — henter confidence-tærskel og ekskluderede domæner
 *
 * @param body.personName   - Personens fulde navn
 * @param body.companies    - Tilknyttede virksomheder (alle, ikke trunceret)
 * @param body.city         - By (valgfrit)
 * @param body.batch        - Batch-nummer, 0-baseret (default: 0)
 * @returns { articles, tokensUsed, hasMore, nextBatch, batchCompanies }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, braveRateLimit } from '@/app/lib/rateLimit';
import { withBraveCache } from '@/app/lib/searchCache';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Antal virksomheder per batch */
const BATCH_SIZE = 5;

// ─── Ekskluderede domæner ─────────────────────────────────────────────────────

const EXCLUDED_ARTICLE_DOMAINS = [
  'ownr.dk',
  'estatistik.dk',
  'profiler.dk',
  'krak.dk',
  'proff.dk',
  'paqle.dk',
  'erhvervplus.dk',
  'lasso.dk',
  'cvrapi.dk',
  'find-virksomhed.dk',
  'virksomhedskartoteket.dk',
  'crunchbase.com',
  'b2bhint.com',
  'resights.dk',
];

/**
 * Returnerer true hvis URL'ens domæne er på ekskluderingslisten.
 *
 * @param url - URL der skal tjekkes
 */
function isExcludedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return EXCLUDED_ARTICLE_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** En nyhedsartikel */
interface ArticleResult {
  title: string;
  url: string;
  source: string;
  date?: string;
  description?: string;
}

/** Input-format */
interface PersonInput {
  personName: string;
  companies?: Array<{ cvr: number | string; name: string; role?: string }>;
  city?: string;
  /** Batch-nummer, 0-baseret. Batch 0 inkluderer personens egne artikler + første 5 virksomheder. */
  batch?: number;
}

/** Brave-resultat råformat */
interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  meta_url?: { hostname?: string };
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/**
 * Henter blokerede domæner fra ai_settings-tabellen.
 *
 * @returns Array af domæner der skal ekskluderes
 */
async function fetchExcludedDomains(): Promise<string[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return EXCLUDED_ARTICLE_DOMAINS;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await client
      .from('ai_settings')
      .select('value')
      .eq('key', 'excluded_domains')
      .single();
    if (Array.isArray(data?.value) && data.value.length > 0) {
      return Array.from(new Set([...EXCLUDED_ARTICLE_DOMAINS, ...(data.value as string[])]));
    }
    return EXCLUDED_ARTICLE_DOMAINS;
  } catch {
    return EXCLUDED_ARTICLE_DOMAINS;
  }
}

// ─── Brave Search ─────────────────────────────────────────────────────────────

/**
 * Søger via Brave Search API og returnerer rå web-resultater.
 *
 * @param key              - Brave Search Subscription Token
 * @param query            - Søgeforespørgsel
 * @param count            - Antal resultater (max 20 pr. kald)
 */
async function searchBrave(
  key: string,
  query: string,
  count = 20,
  freshness?: string
): Promise<ArticleResult[]> {
  const params = new URLSearchParams({ q: query, count: String(count), country: 'dk' });
  if (freshness) params.set('freshness', freshness);
  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = await res.json();
  const raw: BraveWebResult[] = data.web?.results ?? [];
  if (raw.length === 0) return [];
  const seen = new Set<string>();
  return raw
    .filter((r) => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .map((r) => ({
      title: r.title?.trim() ?? '',
      url: r.url?.trim() ?? '',
      source: r.meta_url?.hostname?.replace(/^www\./, '').trim() ?? '',
      description: r.description?.trim().slice(0, 150) ?? undefined,
      date: r.age?.trim() ?? undefined,
    }))
    .filter((r) => r.title && r.url)
    .filter((r) => !isExcludedDomain(r.url));
}

/**
 * Rolleprioritet til sortering af virksomheder — direktør foretrækkes.
 *
 * @param role - Rollebetegnelse
 */
function rolePriority(role?: string): number {
  if (!role) return 99;
  const r = role.toLowerCase();
  if (r.includes('direktør') || r.includes('ceo')) return 1;
  if (r.includes('bestyrelsesformand')) return 2;
  if (r.includes('bestyrelsesmedlem')) return 3;
  if (r.includes('ejer') || r.includes('partner')) return 4;
  return 5;
}

/**
 * Søger artikler om en person og en given batch af virksomheder via parallelle Brave-queries.
 * Batch 0 inkluderer personens egne generiske artikelsøgninger.
 * Efterfølgende batches søger kun de næste 5 virksomheder.
 *
 * @param key        - Brave Search Subscription Token
 * @param personName - Personens fulde navn
 * @param companies  - Alle tilknyttede virksomheder (sorteres efter rolle)
 * @param batch      - Batch-nummer, 0-baseret
 * @returns { results: artikelresultater, batchCompanyNames: virksomhedsnavne i dette batch }
 */
async function searchBravePersonArticles(
  key: string,
  personName: string,
  companies: Array<{ cvr: number | string; name: string; role?: string }>,
  batch: number
): Promise<{ results: ArticleResult[]; batchCompanyNames: string[] }> {
  const sortedCompanies = [...companies].sort(
    (a, b) => rolePriority(a.role) - rolePriority(b.role)
  );
  const batchStart = batch * BATCH_SIZE;
  const batchCompanies = sortedCompanies.slice(batchStart, batchStart + BATCH_SIZE);

  const queries: Promise<ArticleResult[]>[] = [];

  // Batch 0: medtag generiske personartikelsøgninger + seneste måneds artikler
  if (batch === 0) {
    queries.push(searchBrave(key, `"${personName}" nyheder artikel`, 20));
    queries.push(
      searchBrave(
        key,
        `"${personName}" site:dr.dk OR site:tv2.dk OR site:borsen.dk OR site:berlingske.dk OR site:politiken.dk`,
        10
      )
    );
    // Seneste måned — sikrer nyeste artikler prioriteres
    queries.push(searchBrave(key, `"${personName}" nyheder artikel`, 10, 'pm'));
  }

  // Virksomhedsspecifikke queries for dette batch
  for (const c of batchCompanies) {
    queries.push(searchBrave(key, `"${c.name}" "${personName}"`, 5));
    queries.push(searchBrave(key, `"${c.name}" nyheder artikel`, 5));
  }

  const results = await Promise.allSettled(queries);
  const allResults: ArticleResult[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allResults.push(...r.value);
  }

  const seen = new Set<string>();
  const merged: ArticleResult[] = [];
  for (const r of allResults) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      merged.push(r);
    }
  }

  logger.log(
    `[person-search/articles] batch=${batch}: ${merged.length} merged for "${personName}", virksomheder: ${batchCompanies.map((c) => c.name).join(', ') || '(ingen)'}`
  );

  return { results: merged, batchCompanyNames: batchCompanies.map((c) => c.name) };
}

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Bygger system prompt til rangering af artikler om en person.
 *
 * @returns Komplet system prompt til Claude
 */
function buildArticlesSystemPrompt(): string {
  return `Du er en dansk medieekspert. Du rangerer og filtrerer nyheder/artikler om en dansk PERSON.

Din opgave:
1. Vurdér om hvert hit handler om DENNE SPECIFIKKE PERSON (ikke en anden med samme navn)
2. Prioritér artikler der nævner personens fulde navn og helst kontekst (virksomhed, by, branche)
3. Sortér artikler efter dato — NYESTE artikler FØRST. Prioritér artikler fra de seneste 30 dage over ældre artikler.
4. Forbedre snippet-beskrivelser til max 100 tegn dansk tekst

EKSKLUDEREDE DOMÆNER — inkludér ALDRIG:
ownr.dk, estatistik.dk, profiler.dk, krak.dk, proff.dk, paqle.dk, erhvervplus.dk, lasso.dk, cvrapi.dk, find-virksomhed.dk, virksomhedskartoteket.dk, crunchbase.com, b2bhint.com, resights.dk

AFVIS et resultat hvis:
- Det handler om en ANDEN person med samme navn
- Det er en generisk telefonbog/adressebog-side
- Det er åbenlyst spam eller irrelevant
- Det stammer fra et af de ekskluderede domæner

Returner KUN validt JSON uden tekst før/efter:

{
  "articles": [
    {
      "title": "Artiklens titel",
      "url": "https://...",
      "source": "Kildename",
      "date": "15. jan. 2025",
      "description": "Max 100 tegn beskrivelse"
    }
  ]
}

- Brug KUN de givne URLs fra Brave — opfind IKKE nye URLs
- Returner op til 15 artikler`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

/** Sociale medie-domæner der filtreres fra artikellisten */
const SOCIAL_DOMAINS = [
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
];

/**
 * Returnerer true hvis URL'en er et socialt medie-domæne.
 *
 * @param url - URL der skal tjekkes
 */
function isSocialDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return SOCIAL_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * Konverterer en dato-streng (ISO, relativ "X days ago" etc.) til sorterbar timestamp.
 * Returnerer 0 hvis datoen ikke kan parses.
 *
 * @param dateStr - Datostreng fra Brave/Claude
 */
function parseDateForSort(dateStr: string | undefined): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.getTime();
  const agoMatch = dateStr.match(/(\d+)\s+(hour|day|week|month|year|time|dag|uge|m.ned|.r)/i);
  if (agoMatch) {
    const n = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2].toLowerCase();
    const now = Date.now();
    if (unit.startsWith('hour') || unit.startsWith('time')) return now - n * 3_600_000;
    if (unit.startsWith('day') || unit.startsWith('dag')) return now - n * 86_400_000;
    if (unit.startsWith('week') || unit.startsWith('uge')) return now - n * 7 * 86_400_000;
    if (unit.startsWith('month') || unit.startsWith('m')) return now - n * 30 * 86_400_000;
    if (unit.startsWith('year') || unit.startsWith('.r')) return now - n * 365 * 86_400_000;
  }
  return 0;
}

/**
 * Parser Claude's JSON-svar — udtrækker kun artikler.
 *
 * @param text - Rå tekstsvar fra Claude
 */
function parseArticlesResponse(text: string): ArticleResult[] {
  try {
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ??
      text.match(/```\s*([\s\S]*?)\s*```/) ??
      text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return [];

    const raw = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
    const rawArticles: unknown[] = Array.isArray(raw.articles) ? raw.articles : [];

    return rawArticles
      .slice(0, 15)
      .filter(
        (a): a is Record<string, unknown> =>
          typeof a === 'object' &&
          a !== null &&
          typeof (a as Record<string, unknown>).title === 'string' &&
          typeof (a as Record<string, unknown>).url === 'string'
      )
      .filter((a) => {
        const url = String(a.url);
        return url.startsWith('https://') || url.startsWith('http://');
      })
      .map((a) => ({
        title: String(a.title).trim(),
        url: String(a.url).trim(),
        source: typeof a.source === 'string' ? a.source.trim() : 'Dansk medie',
        date: typeof a.date === 'string' ? a.date.trim() : undefined,
        description:
          typeof a.description === 'string' ? a.description.trim().slice(0, 150) : undefined,
      }))
      .filter((a) => !isSocialDomain(a.url))
      .sort((a, b) => parseDateForSort(b.date) - parseDateForSort(a.date));
  } catch {
    return [];
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/person-search/articles
 * Søger og rangerer nyheder/artikler om en person via Brave Search + Claude.
 * Understøtter dynamisk batching med `batch`-parameter — frontend kalder gentagne gange
 * til `hasMore` er false. Ingen max-begrænsning på antal virksomheder.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, braveRateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey)
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });

  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!braveKey)
    return NextResponse.json({ error: 'BRAVE_SEARCH_API_KEY ikke konfigureret' }, { status: 500 });

  let body: PersonInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { personName, companies = [], batch: rawBatch = 0 } = body;
  if (!personName?.trim())
    return NextResponse.json({ error: 'personName er påkrævet' }, { status: 400 });

  const batch = typeof rawBatch === 'number' && rawBatch >= 0 ? Math.floor(rawBatch) : 0;

  // Beregn om der er flere batches efter dette
  const sortedCompanies = [...companies].sort(
    (a, b) => rolePriority(a.role) - rolePriority(b.role)
  );
  const nextBatchStart = (batch + 1) * BATCH_SIZE;
  const hasMore = sortedCompanies.length > nextBatchStart;

  // ── Brave-søgning + Supabase parallelt ──
  // Brave results are cached 24h in Supabase search_cache to reduce API usage.
  let braveResults: ArticleResult[];
  let batchCompanyNames: string[];
  let dbExcludedDomains: string[];

  try {
    const [braveOutput, domains] = await Promise.all([
      withBraveCache(`ps_articles|${personName.toLowerCase()}|b${batch}`, () =>
        searchBravePersonArticles(braveKey, personName, companies, batch)
      ),
      fetchExcludedDomains(),
    ]);
    braveResults = braveOutput.results;
    batchCompanyNames = braveOutput.batchCompanyNames;
    dbExcludedDomains = domains;
  } catch (err) {
    logger.error('[person-search/articles] Initialiseringsfejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }

  // Anvend ekstra DB-domæne-filter
  if (dbExcludedDomains.length > EXCLUDED_ARTICLE_DOMAINS.length) {
    const dbExtra = new Set(dbExcludedDomains.filter((d) => !EXCLUDED_ARTICLE_DOMAINS.includes(d)));
    braveResults = braveResults.filter((r) => {
      try {
        const hostname = new URL(r.url).hostname.replace(/^www\./, '');
        return ![...dbExtra].some((d) => hostname === d || hostname.endsWith(`.${d}`));
      } catch {
        return true;
      }
    });
  }

  logger.log(
    `[person-search/articles] "${personName}" batch=${batch}: ${braveResults.length} rå Brave-resultater, hasMore=${hasMore}`
  );

  // ── Byg Claude-besked ──
  const personContext = [
    `Personens fulde navn: ${personName}`,
    batchCompanyNames.length > 0
      ? `Virksomheder i dette søgebatch: ${batchCompanyNames.join(', ')}`
      : null,
    companies.length > 0
      ? `Alle tilknyttede virksomheder (${companies.length} total): ${companies
          .slice(0, 10)
          .map((c) => `${c.name} (CVR ${c.cvr})`)
          .join(', ')}${companies.length > 10 ? ' …' : ''}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const braveSummary =
    braveResults.length > 0
      ? braveResults
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.date ? `\n   Dato: ${r.date}` : ''}${r.description ? `\n   Snippet: ${r.description}` : ''}`
          )
          .join('\n\n')
      : '(Ingen Brave-resultater for denne søgning)';

  const userMessage = `Person:\n${personContext}\n\nBrave Search-resultater (${braveResults.length} hits):\n\n${braveSummary}\n\nRangér og filtrer disse resultater — returner kun artikler der handler om DENNE person.`;

  // ── Kald Claude ──
  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: buildArticlesSystemPrompt(),
      messages: [{ role: 'user', content: userMessage }],
    });

    const totalTokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    const finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const articles = parseArticlesResponse(finalText);

    logger.log(
      `[person-search/articles] "${personName}" batch=${batch}: ${articles.length} artikler, tokens=${totalTokens}, hasMore=${hasMore}`
    );

    if (articles.length === 0) {
      logger.warn(
        '[person-search/articles] Ingen artikler parsede. Råsvar:',
        finalText.slice(0, 300)
      );
    }

    return NextResponse.json({
      articles,
      tokensUsed: totalTokens,
      hasMore,
      nextBatch: batch + 1,
      batchCompanies: batchCompanyNames,
      source: 'brave+claude',
    });
  } catch (err) {
    logger.error('[person-search/articles] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl', articles: [] }, { status: 500 });
  }
}
