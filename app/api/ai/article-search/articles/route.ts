/**
 * POST /api/ai/article-search/articles
 *
 * Split-endpoint til progressiv loading — søger KUN nyheder/artikler om en dansk virksomhed.
 * Del af parallelt søge-flow: kald dette endpoint sideløbende med /socials.
 *
 * Strategi:
 * 1. Brave Search — søger artikler via 3 parallelle queries
 * 2. Claude — rangerer og filtrerer resultater
 * 3. Supabase — henter ekskluderede domæner
 *
 * @param body.companyName  - Virksomhedens navn
 * @param body.cvr          - CVR-nummer (valgfrit)
 * @param body.industry     - Branchebeskrivelse (valgfrit)
 * @param body.employees    - Antal ansatte (valgfrit)
 * @param body.city         - By (valgfrit)
 * @param body.keyPersons   - Nøglepersoner (valgfrit)
 * @returns { articles, tokensUsed }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, braveRateLimit } from '@/app/lib/rateLimit';
import { withBraveCache } from '@/app/lib/searchCache';
import { logger } from '@/app/lib/logger';
import { resolveUserId } from '@/lib/api/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
interface CompanyInput {
  companyName: string;
  cvr?: string;
  industry?: string;
  employees?: number | string;
  city?: string;
  keyPersons?: string[];
}

/** Brave-resultat råformat */
interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  meta_url?: { hostname?: string };
}

/** Serper.dev organisk resultat råformat */
interface SerperOrganicResult {
  title: string;
  link: string;
  snippet?: string;
  date?: string;
  source?: string;
  displayLink?: string;
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
 * @param key   - Brave Search Subscription Token
 * @param query - Søgeforespørgsel
 * @param count - Antal resultater (max 20 pr. kald)
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

// ─── Serper.dev Search ────────────────────────────────────────────────────────

/**
 * Søger via Serper.dev (Google-søgning) og returnerer artikelresultater.
 *
 * @param apiKey      - Serper.dev API-nøgle
 * @param query       - Søgeforespørgsel
 * @param tbs         - Google tbs-parameter til datofilter (f.eks. 'qdr:m' = seneste måned)
 */
async function searchSerper(
  apiKey: string,
  query: string,
  tbs = 'qdr:m'
): Promise<ArticleResult[]> {
  const body = JSON.stringify({ q: query, gl: 'dk', hl: 'da', num: 10, tbs });
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = (await res.json()) as { organic?: SerperOrganicResult[] };
  const items: SerperOrganicResult[] = data.organic ?? [];
  if (items.length === 0) return [];

  const seen = new Set<string>();
  return items
    .filter((item) => {
      if (!item.link || seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    })
    .map((item) => ({
      title: item.title?.trim() ?? '',
      url: item.link?.trim() ?? '',
      source: (item.source ?? item.displayLink ?? '').replace(/^www\./, '').trim(),
      description: item.snippet?.trim().slice(0, 150) ?? undefined,
      date: item.date?.trim() ?? undefined,
    }))
    .filter((r) => r.title && r.url)
    .filter((r) => !isExcludedDomain(r.url));
}

/**
 * Søger artikler via Serper.dev med 2 parallelle queries.
 * Returnerer tom liste (aldrig kast) hvis nøgle mangler eller Serper fejler.
 *
 * @param apiKey      - Serper.dev API-nøgle
 * @param companyName - Virksomhedens navn
 */
async function searchSerperArticles(apiKey: string, companyName: string): Promise<ArticleResult[]> {
  const currentYear = new Date().getFullYear();
  const qGeneral = `"${companyName}" nyheder OR artikel OR omtale`;
  const qMedia = `"${companyName}" ${currentYear} site:dr.dk OR site:tv2.dk OR site:borsen.dk OR site:berlingske.dk OR site:politiken.dk`;

  try {
    const [general, media] = await Promise.all([
      searchSerper(apiKey, qGeneral, 'qdr:m').catch(() => [] as ArticleResult[]),
      searchSerper(apiKey, qMedia, 'qdr:m3').catch(() => [] as ArticleResult[]),
    ]);
    return dedupArticles([...general, ...media]);
  } catch {
    return [];
  }
}

/**
 * Fjerner duplikater fra et array af artikler baseret på URL.
 *
 * @param articles - Array af artikler med potentielle duplikater
 * @returns Deduplikeret array med første forekomst bevaret
 */
function dedupArticles(articles: ArticleResult[]): ArticleResult[] {
  const seen = new Set<string>();
  return articles.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Søger artikler via parallelle Brave-queries og merger resultater.
 *
 * Strategi (3 faser):
 * 1. Seneste uge (pw) — primær kilde, kørers altid parallelt med måneds-queries
 * 2. Seneste måned (pm) — supplement til ugentlige resultater, inkluderer årstal i query
 * 3. Seneste år (py) — fallback, KUN hvis fase 1+2 giver færre end 5 resultater
 *
 * Årstallet tilføjes til query3 for at hjælpe Brave finde nyere indekserede artikler.
 * Prioritering i merge: uge > måned > år.
 *
 * @param key         - Brave Search Subscription Token
 * @param companyName - Virksomhedens navn
 */
async function searchBraveArticles(key: string, companyName: string): Promise<ArticleResult[]> {
  const currentYear = new Date().getFullYear();
  const q1 = `"${companyName}" anmeldelse OR artikel OR nyheder OR guide OR omtale`;
  const qMedia = `"${companyName}" site:dr.dk OR site:tv2.dk OR site:borsen.dk OR site:berlingske.dk OR site:politiken.dk`;
  const qYear = `"${companyName}" nyheder ${currentYear}`;

  // Fase 1+2: Uge- og måneds-queries køres parallelt for minimal latency
  const [weekGeneral, weekMedia, monthGeneral, monthMedia, monthYearQuery] = await Promise.all([
    searchBrave(key, q1, 10, 'pw'), // Seneste uge — bred søgning (højeste prioritet)
    searchBrave(key, qMedia, 10, 'pw'), // Seneste uge — kun store medier
    searchBrave(key, q1, 20, 'pm'), // Seneste måned — bred søgning
    searchBrave(key, qMedia, 10, 'pm'), // Seneste måned — store medier
    searchBrave(key, qYear, 10, 'pm'), // Seneste måned — med årstal for bedre friskhed
  ]);

  const weekCombined = dedupArticles([...weekGeneral, ...weekMedia]);
  const monthCombined = dedupArticles([...monthGeneral, ...monthMedia, ...monthYearQuery]);

  // Merge med prioritet: seneste uge > seneste måned
  const merged = dedupArticles([...weekCombined, ...monthCombined]);

  // Fase 3: Fald tilbage til seneste år KUN hvis for få resultater
  if (merged.length < 5) {
    const [yearGeneral, yearYearQuery] = await Promise.all([
      searchBrave(key, q1, 20, 'py'),
      searchBrave(key, qYear, 15, 'py'),
    ]);
    const yearCombined = dedupArticles([...yearGeneral, ...yearYearQuery]);
    const seen = new Set(merged.map((r) => r.url));
    for (const r of yearCombined) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        merged.push(r);
      }
    }
  }

  return merged;
}

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Bygger system prompt til rangering af artikler om en virksomhed.
 *
 * @returns Komplet system prompt til Claude
 */
function buildArticlesSystemPrompt(): string {
  return `Du er en dansk medieekspert. Du rangerer og filtrerer nyheder/artikler om en dansk VIRKSOMHED.

Din opgave:
1. Vurdér om hvert hit handler om DENNE SPECIFIKKE virksomhed (ikke en anden med lignende navn)
2. Prioritér danske artikler, men inkludér internationale hvis relevante
3. Sortér artikler efter dato — NYESTE artikler FØRST. Prioritér artikler fra de seneste 30 dage stærkt over ældre.
4. AFVIS artikler ældre end 12 måneder — med mindre de er ekstraordinært relevante (f.eks. eneste artikel om virksomheden)
5. Forbedre snippet-beskrivelser til max 100 tegn dansk tekst

EKSKLUDEREDE DOMÆNER — inkludér ALDRIG:
ownr.dk, estatistik.dk, profiler.dk, krak.dk, proff.dk, paqle.dk, erhvervplus.dk, lasso.dk, cvrapi.dk, find-virksomhed.dk, virksomhedskartoteket.dk, crunchbase.com, b2bhint.com, resights.dk

AFVIS et resultat hvis:
- Det handler om en ANDEN virksomhed med samme eller lignende navn
- Det er et jobopslag (stillingsopslag, karriere, ledige stillinger)
- Det er en generisk brancheportal der bare lister virksomheden
- Det er åbenlyst spam eller irrelevant indhold
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

- Brug KUN de givne URLs fra søgeresultaterne — opfind IKKE nye URLs
- Returner op til 15 artikler, sorteret nyeste FØRST`;
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
 * POST /api/ai/article-search/articles
 * Søger og rangerer nyheder/artikler om en virksomhed via Brave Search + Claude.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, braveRateLimit);
  if (limited) return limited;
  // Article-search does not access tenant-scoped data — user auth is sufficient.
  // Consistent with /api/ai/chat which also uses resolveUserId().
  const userId = await resolveUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey)
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });

  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  const serperApiKey = process.env.SERPER_API_KEY?.trim();

  // Brave er primær kilde — fejl kun hvis hverken Brave eller Serper er konfigureret
  if (!braveKey && !serperApiKey)
    return NextResponse.json(
      {
        error: 'Ingen søge-API konfigureret (BRAVE_SEARCH_API_KEY eller SERPER_API_KEY påkrævet)',
      },
      { status: 500 }
    );

  let body: CompanyInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { companyName, cvr, industry, employees, city, keyPersons } = body;
  if (!companyName?.trim())
    return NextResponse.json({ error: 'companyName er påkrævet' }, { status: 400 });

  // ── Brave + Google CSE + Supabase parallelt ──
  // Brave results are cached 24h in Supabase search_cache to reduce API usage.
  // Google CSE køres parallelt med Brave for at øge dækning — resultaterne merges og dedupliceres.
  let rawResults: ArticleResult[];
  let dbExcludedDomains: string[];

  try {
    const cacheDate = new Date().toISOString().slice(0, 10);

    const bravePromise = braveKey
      ? withBraveCache(`articles|${companyName.toLowerCase()}|${cvr ?? ''}|${cacheDate}`, () =>
          searchBraveArticles(braveKey, companyName)
        ).catch((err: unknown) => {
          logger.log(
            `[article-search/articles] Brave fejl: ${err instanceof Error ? err.message : String(err)}`
          );
          return [] as ArticleResult[];
        })
      : Promise.resolve([] as ArticleResult[]);

    const serperPromise = serperApiKey
      ? searchSerperArticles(serperApiKey, companyName).catch((err: unknown) => {
          logger.log(
            `[article-search/articles] Serper fejl: ${err instanceof Error ? err.message : String(err)}`
          );
          return [] as ArticleResult[];
        })
      : Promise.resolve([] as ArticleResult[]);

    const [braveResults, serperResults, resolvedDbDomains] = await Promise.all([
      bravePromise,
      serperPromise,
      fetchExcludedDomains(),
    ]);

    dbExcludedDomains = resolvedDbDomains;

    logger.log(
      `[article-search/articles] "${companyName}": Brave=${braveResults.length}, Serper=${serperResults.length} rå resultater`
    );

    // Merge: Brave har prioritet (kommer først), Serper supplementerer
    rawResults = dedupArticles([...braveResults, ...serperResults]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Søgefejl';
    return NextResponse.json({ error: `Søgning fejlede: ${msg}` }, { status: 502 });
  }

  // Anvend ekstra DB-domæne-filter
  if (dbExcludedDomains.length > EXCLUDED_ARTICLE_DOMAINS.length) {
    const dbExtra = new Set(dbExcludedDomains.filter((d) => !EXCLUDED_ARTICLE_DOMAINS.includes(d)));
    rawResults = rawResults.filter((r) => {
      try {
        const hostname = new URL(r.url).hostname.replace(/^www\./, '');
        return ![...dbExtra].some((d) => hostname === d || hostname.endsWith(`.${d}`));
      } catch {
        return true;
      }
    });
  }

  logger.log(
    `[article-search/articles] "${companyName}": ${rawResults.length} samlede resultater efter merge+dedup`
  );

  // Ingen resultater fra hverken Brave eller Serper — spring Claude over og returnér tomt
  if (rawResults.length === 0) {
    const searchSource = [braveKey ? 'brave' : null, serperApiKey ? 'serper' : null]
      .filter(Boolean)
      .join('+');
    return NextResponse.json({ articles: [], tokensUsed: 0, source: `${searchSource}+no-results` });
  }

  // ── Byg Claude-besked ──
  const companyContext = [
    `Virksomhedsnavn: ${companyName}`,
    cvr ? `CVR-nummer: ${cvr}` : null,
    industry ? `Branche: ${industry}` : null,
    employees ? `Ansatte: ${employees}` : null,
    city ? `By: ${city}` : null,
    keyPersons?.length ? `Nøglepersoner: ${keyPersons.slice(0, 6).join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const resultSummary = rawResults
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.date ? `\n   Dato: ${r.date}` : ''}${r.description ? `\n   Snippet: ${r.description}` : ''}`
    )
    .join('\n\n');

  const userMessage = `Virksomhed:\n${companyContext}\n\nSøgeresultater (${rawResults.length} hits):\n\n${resultSummary}\n\nRangér og filtrer disse resultater — returner kun artikler der handler om DENNE virksomhed.`;

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
      `[article-search/articles] "${companyName}": ${articles.length} artikler, tokens=${totalTokens}`
    );

    const searchSource = [braveKey ? 'brave' : null, serperApiKey ? 'serper' : null]
      .filter(Boolean)
      .join('+');
    return NextResponse.json({
      articles,
      tokensUsed: totalTokens,
      source: `${searchSource}+claude`,
    });
  } catch (err) {
    const msg =
      err instanceof Anthropic.APIError
        ? `API-fejl (${err.status}): ${err.message}`
        : err instanceof Error
          ? err.message
          : 'Ukendt fejl';
    return NextResponse.json({ error: msg, articles: [] }, { status: 500 });
  }
}
