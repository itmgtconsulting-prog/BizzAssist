/**
 * POST /api/ai/article-search/articles
 *
 * Split-endpoint til progressiv loading — søger KUN nyheder/artikler om en dansk virksomhed
 * eller person. Del af parallelt søge-flow: kald dette endpoint sideløbende med /socials.
 *
 * Strategi:
 * 1. Serper.dev (Google) — 3 parallelle queries med forskellig tidshorisont og fokus.
 *    CVR-lovformens suffiks (ApS, A/S, IVS …) strippes inden søgning.
 *    - Seneste år (qdr:y, num=20) — primær kilde (qdr:m3 undgås — returnerer støj for SMV'er)
 *    - Ingen tidsfilter (num=20) — fanger ældre artikler f.eks. fra 2022-2023
 *    - Site-filter (num=20) — søger kun på admin-konfigurerede foretrukne danske medier
 *    (Serper fejler med 400 ved num>20 kombineret med tbs-filter)
 * 2. Claude — rangerer og filtrerer resultater, prioriterer foretrukne mediekilder
 * 3. Supabase — henter ekskluderede domæner og primære mediedomæner (admin-konfigureret)
 *
 * @param body.entityType   - 'company' (standard) eller 'person'
 * @param body.companyName  - Virksomhedens navn (entityType=company)
 * @param body.name         - Personens fulde navn (entityType=person)
 * @param body.company      - Tilknyttet virksomhedsnavn for personen (entityType=person, valgfrit)
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
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';

export const runtime = 'nodejs';
export const maxDuration = 90;

// ─── Ekskluderede domæner ─────────────────────────────────────────────────────

/** Fallback-liste af ekskluderede domæner (konkurrenter og katalogsider). */
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
 * Foretrukne danske mediedomæner brugt som fallback når admin-konfiguration mangler.
 * Matcher standardlisten i AiMediaAgentsClient.tsx.
 */
const DEFAULT_PRIMARY_MEDIA_DOMAINS = [
  'dr.dk',
  'tv2.dk',
  'borsen.dk',
  'berlingske.dk',
  'politiken.dk',
  'jyllands-posten.dk',
  'bt.dk',
  'eb.dk',
  'version2.dk',
  'computerworld.dk',
  'information.dk',
  'weekendavisen.dk',
  'finans.dk',
  'medwatch.dk',
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

/** Input-format for virksomhedssøgning */
interface CompanyInput {
  /** Angiver om søgningen er for en virksomhed eller person. Standard: 'company'. */
  entityType?: 'company' | 'person';
  companyName?: string;
  /** Personens fulde navn — bruges når entityType='person'. */
  name?: string;
  /** Tilknyttet virksomhedsnavn for personen — bruges når entityType='person'. */
  company?: string;
  cvr?: string;
  industry?: string;
  employees?: number | string;
  city?: string;
  keyPersons?: string[];
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

/** Serper.dev news resultat råformat */
interface SerperNewsResult {
  title: string;
  link: string;
  snippet?: string;
  date?: string;
  source?: string;
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

/**
 * Henter admin-konfigurerede foretrukne mediedomæner fra ai_settings-tabellen.
 * Bruges til at bygge en site:-filter Serper-query og til Claude-system-prompten.
 *
 * @returns Array af foretrukne domæner (f.eks. ['dr.dk', 'berlingske.dk'])
 */
async function fetchPrimaryMediaDomains(): Promise<string[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return DEFAULT_PRIMARY_MEDIA_DOMAINS;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await client
      .from('ai_settings')
      .select('value')
      .eq('key', 'primary_media_domains')
      .single();
    if (Array.isArray(data?.value) && data.value.length > 0) {
      return data.value as string[];
    }
    return DEFAULT_PRIMARY_MEDIA_DOMAINS;
  } catch {
    return DEFAULT_PRIMARY_MEDIA_DOMAINS;
  }
}

/** Maksimalt antal artikler der sendes til Claude (fallback). */
const DEFAULT_MAX_ARTICLES = 40;

/** Maksimalt antal tokens til Claude-kaldet (fallback). */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Henter article-search grænseværdier (max artikler + max tokens) fra ai_settings.
 * Bruges til at styre Claude-prompt-størrelsen og token-budgettet.
 *
 * @returns { maxArticles, maxTokens }
 */
async function fetchArticleLimits(): Promise<{ maxArticles: number; maxTokens: number }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { maxArticles: DEFAULT_MAX_ARTICLES, maxTokens: DEFAULT_MAX_TOKENS };
  }
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: rows } = await client
      .from('ai_settings')
      .select('key, value')
      .in('key', ['max_articles_per_search', 'max_tokens_per_search']);

    let maxArticles = DEFAULT_MAX_ARTICLES;
    let maxTokens = DEFAULT_MAX_TOKENS;

    for (const row of rows ?? []) {
      if (row.key === 'max_articles_per_search' && typeof row.value === 'number' && row.value > 0) {
        maxArticles = row.value;
      }
      if (row.key === 'max_tokens_per_search' && typeof row.value === 'number' && row.value > 0) {
        maxTokens = row.value;
      }
    }

    return { maxArticles, maxTokens };
  } catch {
    return { maxArticles: DEFAULT_MAX_ARTICLES, maxTokens: DEFAULT_MAX_TOKENS };
  }
}

// ─── Serper.dev Search ────────────────────────────────────────────────────────

/**
 * Søger via Serper.dev (Google-søgning) og returnerer artikelresultater.
 *
 * @param apiKey - Serper.dev API-nøgle
 * @param query  - Søgeforespørgsel
 * @param tbs    - Google tbs-parameter til datofilter (f.eks. 'qdr:m3' = seneste 3 måneder). Udelad for ingen filter.
 * @param num    - Antal resultater (max 100 pr. kald hos Serper)
 */
async function searchSerper(
  apiKey: string,
  query: string,
  tbs?: string,
  num = 30
): Promise<ArticleResult[]> {
  const payload: Record<string, unknown> = { q: query, gl: 'dk', hl: 'da', num };
  if (tbs) payload.tbs = tbs;
  const body = JSON.stringify(payload);
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
 * Søger via Serper.dev /news endpoint (Google Nyheder) og returnerer nyhedsresultater.
 * Returnerer typisk redaktionelle nyhedsartikler frem for SEO/katalog-sider.
 *
 * @param apiKey - Serper.dev API-nøgle
 * @param query  - Søgeforespørgsel (typisk blot virksomhedsnavnet)
 * @param num    - Antal resultater (max 100)
 */
async function searchSerperNews(apiKey: string, query: string, num = 20): Promise<ArticleResult[]> {
  const payload: Record<string, unknown> = { q: query, gl: 'dk', hl: 'da', num };
  const body = JSON.stringify(payload);
  const res = await fetch('https://google.serper.dev/news', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Serper News HTTP ${res.status}`);
  const data = (await res.json()) as { news?: SerperNewsResult[] };
  const items: SerperNewsResult[] = data.news ?? [];
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
      source: (item.source ?? '').replace(/^www\./, '').trim(),
      description: item.snippet?.trim().slice(0, 150) ?? undefined,
      date: item.date?.trim() ?? undefined,
    }))
    .filter((r) => r.title && r.url)
    .filter((r) => !isExcludedDomain(r.url));
}

/**
 * Strips common Danish/international legal suffixes from a company name so that
 * the cleaned name matches how journalists and media write about the company.
 *
 * CVR often stores names as "SØRENS VÆRTSHUS APS" — the quoted suffix produces
 * zero Google results because articles always omit it.
 *
 * @param name - Raw company name from CVR (e.g. "SØRENS VÆRTSHUS APS")
 * @returns Cleaned name suitable for a search query (e.g. "Sørens Værtshus")
 */
function cleanCompanyName(name: string): string {
  // Remove trailing legal suffix (case-insensitive, with optional punctuation)
  const cleaned = name
    .replace(
      /\s+(ApS|A\/S|IVS|K\/S|P\/S|I\/S|SE|SMBA|FMBA|Fonden|Forening|Fond|GmbH|Ltd\.?|Inc\.?|LLC|SRL|BV|NV|AG)\s*$/i,
      ''
    )
    .trim();

  // Convert ALL-CAPS names to title case (e.g. "SØRENS VÆRTSHUS" → "Sørens Værtshus")
  if (cleaned === cleaned.toUpperCase() && cleaned.length > 2) {
    return cleaned.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  }

  return cleaned;
}

/**
 * Søger artikler via Serper.dev med 3 parallelle queries for maksimal dækning.
 *
 * Strategi:
 * - Query 1: seneste år (qdr:y), num=20 — primær kilde. qdr:m3 undgås da det
 *   returnerer støj for virksomheder uden nylig presseomtale.
 * - Query 2: ingen tidsfilter, num=20 — fanger ældre artikler (2022-2023 og ældre)
 * - Query 3: site:-filter med admin-konfigurerede foretrukne danske medier, num=20 —
 *   sikrer at vigtige kilder (DR, Berlingske, Politiken osv.) altid er repræsenteret.
 * - Query 4: /news endpoint (Google Nyheder), num=20 — fanger redaktionelle artikler
 *   fra regionale/lokale medier (Tidende.dk, TV2 Bornholm osv.) der ikke fanges af
 *   /search + keyword-filtre.
 *
 * CVR-lovformens suffiks (ApS, A/S, IVS osv.) strippes inden søgning, da
 * artikler aldrig citerer det officielle CVR-navn med suffiks.
 *
 * Resultater merges og dedupliceres efter URL, med foretrukne medier øverst.
 * Returnerer aldrig kast — fejl fra individuelle queries giver tom liste.
 *
 * @param apiKey         - Serper.dev API-nøgle
 * @param companyName    - Virksomhedens navn (råt CVR-navn — renses internt)
 * @param primaryDomains - Foretrukne mediedomæner fra admin-konfiguration
 */
async function searchSerperArticles(
  apiKey: string,
  companyName: string,
  primaryDomains: string[]
): Promise<ArticleResult[]> {
  const name = cleanCompanyName(companyName);
  const q = `"${name}" nyheder OR artikel OR omtale`;

  // Byg site:-filter query fra de foretrukne mediedomæner
  const siteFilter = primaryDomains.map((d) => `site:${d}`).join(' OR ');
  const qMedia = `"${name}" (${siteFilter})`;

  try {
    // Note: Serper returns a 400 for num>20 combined with tbs filters — cap at 20.
    // News-query bruger kun virksomhedsnavnet — /news-endpointet håndterer relevans selv.
    const [yearly, allTime, mediaOnly, newsResults] = await Promise.all([
      searchSerper(apiKey, q, 'qdr:y', 20).catch(() => [] as ArticleResult[]),
      searchSerper(apiKey, q, undefined, 20).catch(() => [] as ArticleResult[]),
      searchSerper(apiKey, qMedia, undefined, 20).catch(() => [] as ArticleResult[]),
      searchSerperNews(apiKey, name, 20).catch(() => [] as ArticleResult[]),
    ]);
    // Prioritering: foretrukne medier + news (redaktionelt) > seneste år > alle tider
    return dedupArticles([...mediaOnly, ...newsResults, ...yearly, ...allTime]);
  } catch {
    return [];
  }
}

/**
 * Søger artikler om en person via Serper.dev med parallelle queries.
 *
 * Strategi:
 * - Query 1: personnavnet i anførselstegn, seneste år (qdr:y, num=20)
 * - Query 2: personnavnet i anførselstegn, ingen tidsfilter (num=20)
 * - Query 3: personnavnet + tilknyttet virksomhed (num=20)
 * - Query 4: /news endpoint med personnavnet (num=20)
 *
 * @param apiKey         - Serper.dev API-nøgle
 * @param personName     - Personens fulde navn
 * @param company        - Tilknyttet virksomhedsnavn (valgfrit)
 * @param primaryDomains - Foretrukne mediedomæner til site-filter query
 */
async function searchSerperPersonArticles(
  apiKey: string,
  personName: string,
  company: string | undefined,
  primaryDomains: string[]
): Promise<ArticleResult[]> {
  const qPerson = `"${personName}"`;
  const qPersonCompany = company ? `"${personName}" "${company}"` : qPerson;

  // Byg site:-filter query fra foretrukne mediedomæner
  const siteFilter = primaryDomains.map((d) => `site:${d}`).join(' OR ');
  const qMedia = `"${personName}" (${siteFilter})`;

  try {
    const [yearly, allTime, withCompany, newsResults] = await Promise.all([
      searchSerper(apiKey, qPerson, 'qdr:y', 20).catch(() => [] as ArticleResult[]),
      searchSerper(apiKey, qPerson, undefined, 20).catch(() => [] as ArticleResult[]),
      searchSerper(apiKey, qPersonCompany, undefined, 20).catch(() => [] as ArticleResult[]),
      searchSerperNews(apiKey, personName, 20).catch(() => [] as ArticleResult[]),
    ]);

    // Person-artikler prioriteres over firma-artikler; media-filter og nyheder øverst
    const mediaOnly = await searchSerper(apiKey, qMedia, undefined, 20).catch(
      () => [] as ArticleResult[]
    );

    return dedupArticles([...mediaOnly, ...newsResults, ...yearly, ...allTime, ...withCompany]);
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

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Bygger system prompt til rangering af artikler om en virksomhed.
 * Inkluderer admin-konfigurerede foretrukne mediedomæner så Claude prioriterer dem.
 *
 * @param primaryDomains - Foretrukne mediedomæner fra admin-konfiguration
 * @returns Komplet system prompt til Claude
 */
function buildArticlesSystemPrompt(primaryDomains: string[]): string {
  const preferredList = primaryDomains.join(', ');
  return `Du er en dansk medieekspert. Du rangerer og filtrerer nyheder/artikler om en dansk VIRKSOMHED registreret i CVR.

Din opgave:
1. Vurdér om hvert hit handler om DENNE SPECIFIKKE CVR-virksomhed — ikke en anden virksomhed med samme bogstavskombination i et andet land
2. Brug ALLE tilgængelige entitets-anker: CVR-nummer, fulde juridiske navn, branche, by, nøglepersoner. Et resultat der ikke har mindst ét af disse anker knyttet til sig, er sandsynligvis en falsk positiv og skal AFVISES
3. Prioritér artikler fra FORETRUKNE MEDIER — placer dem øverst uanset dato
4. Sortér derefter øvrige artikler efter dato — NYESTE artikler FØRST
5. Inkludér gerne ældre artikler (2022-2023 og ældre) hvis de er relevante — især for mindre virksomheder
6. Forbedre snippet-beskrivelser til max 100 tegn dansk tekst
7. Hvis INGEN af resultaterne klart handler om den danske CVR-virksomhed, returnér en tom articles-liste. Det er bedre at vise "ingen relevante artikler" end at fylde med støj

FORETRUKNE MEDIEDOMÆNER — placer disse ØVERST i resultatlisten:
${preferredList}

EKSKLUDEREDE DOMÆNER — inkludér ALDRIG:
ownr.dk, estatistik.dk, profiler.dk, krak.dk, proff.dk, paqle.dk, erhvervplus.dk, lasso.dk, cvrapi.dk, find-virksomhed.dk, virksomhedskartoteket.dk, crunchbase.com, b2bhint.com, resights.dk

AFVIS et resultat hvis:
- Det handler om en ANDEN virksomhed med samme eller lignende navn (meget almindeligt for 2-3 bogstavs-forkortelser som "HP", "SE", "DK" m.fl. — check altid hele konteksten)
- Det handler om en udenlandsk entitet (indisk delstat, amerikansk byggeprojekt, videnskabelig artikel m.m.) der bare tilfældigvis deler bogstaver med virksomhedens navn
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
- Returner op til 20 artikler, sorteret med foretrukne medier FØRST, derefter nyeste`;
}

/**
 * Bygger system prompt til rangering af artikler om en person.
 * Prioriterer artikler der direkte omtaler personen; virksomhedsartikler er sekundære.
 *
 * @param primaryDomains - Foretrukne mediedomæner fra admin-konfiguration
 * @returns Komplet system prompt til Claude
 */
function buildPersonArticlesSystemPrompt(primaryDomains: string[]): string {
  const preferredList = primaryDomains.join(', ');
  return `Du er en dansk medieekspert. Du rangerer og filtrerer nyheder/artikler om en dansk PERSON.

Din opgave:
1. Vurdér om hvert hit handler om DENNE SPECIFIKKE PERSON (ikke en anden med samme navn)
2. Prioritér artikler der handler om PERSONEN DIREKTE — artikler om virksomheder personen er tilknyttet er sekundært relevante
3. Prioritér artikler fra FORETRUKNE MEDIER — placer dem øverst uanset dato
4. Sortér derefter øvrige artikler efter dato — NYESTE artikler FØRST
5. Forbedre snippet-beskrivelser til max 100 tegn dansk tekst

FORETRUKNE MEDIEDOMÆNER — placer disse ØVERST i resultatlisten:
${preferredList}

EKSKLUDEREDE DOMÆNER — inkludér ALDRIG:
ownr.dk, estatistik.dk, profiler.dk, krak.dk, proff.dk, paqle.dk, erhvervplus.dk, lasso.dk, cvrapi.dk, find-virksomhed.dk, virksomhedskartoteket.dk, crunchbase.com, b2bhint.com, resights.dk

AFVIS et resultat hvis:
- Det handler om en ANDEN person med samme eller lignende navn
- Det er en generisk telefonbog/adressebog/CVR-katalog side
- Det er et jobopslag (stillingsopslag, karriere, ledige stillinger)
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
- Returner op til 20 artikler, sorteret med foretrukne medier FØRST, derefter nyeste`;
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
 * Returnerer true hvis URL'ens domæne er på listen over foretrukne medier.
 *
 * @param url            - URL der skal tjekkes
 * @param primaryDomains - Liste af foretrukne mediedomæner
 */
function isPrimaryDomain(url: string, primaryDomains: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return primaryDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * BIZZ-476: Afgør om en URL er dansk-relevant for en CVR-virksomhed.
 * Vi betragter et resultat som DK-relevant når:
 *   - domænet har `.dk` TLD, ELLER
 *   - domænet står på admin's foretrukne medieliste (tillader fx bloomberg.com
 *     hvis admin eksplicit har hvidlistet det)
 *
 * For danske CVR-virksomheder er dette filter den vigtigste beskyttelse mod
 * internationale støj-resultater der matcher firmaets bogstavskombination
 * (fx "HP Properties" matchede tidligere indiske nyheder om "HP" delstat).
 *
 * @param url            - URL der skal tjekkes
 * @param primaryDomains - Admin-hvidlistede mediedomæner
 */
function isDkRelevant(url: string, primaryDomains: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    if (hostname.endsWith('.dk')) return true;
    return primaryDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * Stable post-processing sort: artikler fra foretrukne medier øverst (bevarer
 * Claude's interne rækkefølge), efterfulgt af øvrige artikler (ligeledes i
 * Claude's rækkefølge). Erstatter Claude's upålidelige media-prioritering.
 *
 * @param articles       - Artikler i Claude's returnerede rækkefølge
 * @param primaryDomains - Foretrukne mediedomæner fra admin-konfiguration
 */
function sortByPrimaryDomains(
  articles: ArticleResult[],
  primaryDomains: string[]
): ArticleResult[] {
  const primary = articles.filter((a) => isPrimaryDomain(a.url, primaryDomains));
  const rest = articles.filter((a) => !isPrimaryDomain(a.url, primaryDomains));
  return [...primary, ...rest];
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
      .slice(0, 20)
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
      .filter((a) => !isSocialDomain(a.url));
  } catch {
    return [];
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/article-search/articles
 * Søger og rangerer nyheder/artikler om en virksomhed eller person via Serper.dev + Claude.
 *
 * Understøtter progressiv to-fase loading via ?phase query param:
 * - ?phase=raw  — returnerer Serper-resultater direkte uden Claude (~2-3s). Ingen tokens brugt.
 * - ?phase=ai   — fuld pipeline: Serper → Claude rangering (~20-60s). Standard-adfærd hvis phase udelades.
 *
 * Frontenden kalder begge faser parallelt: raw-fasen viser foreløbige resultater straks,
 * ai-fasen erstatter dem med kuraterede resultater når Claude er færdig.
 *
 * Understøtter entityType='person' til personsøgning: brug `name` (personens navn) og
 * `company` (tilknyttet virksomhedsnavn, valgfrit) i stedet for `companyName`.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, braveRateLimit);
  if (limited) return limited;
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  /** Faseparameter: 'raw' = kun Serper (hurtigt), 'ai' = Serper + Claude (standard) */
  const phase = request.nextUrl.searchParams.get('phase') ?? 'ai';

  // BIZZ-649: Central AI billing-gate. Gate'n skal først kaldes for 'ai'-
  // fasen fordi 'raw' bruger ikke Anthropic. Men vi gater også på 'raw' for
  // at undgå at en 0-token bruger kan kalde Serper i uendelighed og bypasse
  // afregningen af deres samlede billing-budget.
  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  const serperApiKey = process.env.SERPER_API_KEY?.trim();
  if (!serperApiKey)
    return NextResponse.json({ error: 'SERPER_API_KEY ikke konfigureret' }, { status: 500 });

  // Claude API-nøgle er kun nødvendig i ai-fasen
  const apiKey = phase !== 'raw' ? process.env.BIZZASSIST_CLAUDE_KEY?.trim() : undefined;
  if (phase !== 'raw' && !apiKey) {
    // BIZZ-653: Generisk besked + buy-tokens CTA
    return NextResponse.json(
      {
        error:
          'AI er midlertidigt utilgængelig. Bekræft at dit abonnement er aktivt, eller køb en token-pakke for at fortsætte.',
        code: 'ai_unavailable',
        cta: 'buy_token_pack',
      },
      { status: 503 }
    );
  }

  let body: CompanyInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const {
    entityType = 'company',
    companyName,
    name,
    company,
    cvr,
    industry,
    employees,
    city,
    keyPersons,
  } = body;

  // ── Validér input baseret på entityType ──
  const isPerson = entityType === 'person';
  const searchLabel = isPerson ? (name?.trim() ?? '') : (companyName?.trim() ?? '');
  if (!searchLabel) {
    return NextResponse.json(
      { error: isPerson ? 'name er påkrævet for entityType=person' : 'companyName er påkrævet' },
      { status: 400 }
    );
  }

  // ── Serper + Supabase parallelt ──
  let rawResults: ArticleResult[];
  let dbExcludedDomains: string[];
  let primaryDomains: string[];
  let maxArticles: number;
  let maxTokens: number;

  try {
    // BIZZ-476: Hent admin-konfigurerede primære medier FØR Serper-kaldet så
    // site:-filter-query'en faktisk bruger dem. Tidligere blev
    // DEFAULT_PRIMARY_MEDIA_DOMAINS brugt til søgningen, så admin-ændringer
    // havde ingen effekt på hvilke kilder Serper faktisk spurgte om. Vi
    // kører parallelt med excluded-domain-opslag så no net latency impact.
    const [resolvedDbDomains, resolvedPrimaryDomains, resolvedLimits] = await Promise.all([
      fetchExcludedDomains(),
      fetchPrimaryMediaDomains(),
      phase !== 'raw'
        ? fetchArticleLimits()
        : Promise.resolve({ maxArticles: DEFAULT_MAX_ARTICLES, maxTokens: DEFAULT_MAX_TOKENS }),
    ]);

    const serperResults = await (isPerson
      ? searchSerperPersonArticles(
          serperApiKey,
          searchLabel,
          company,
          resolvedPrimaryDomains
        ).catch((err: unknown) => {
          logger.log(
            `[article-search/articles] Serper person fejl: ${err instanceof Error ? err.message : String(err)}`
          );
          return [] as ArticleResult[];
        })
      : searchSerperArticles(serperApiKey, searchLabel, resolvedPrimaryDomains).catch(
          (err: unknown) => {
            logger.log(
              `[article-search/articles] Serper fejl: ${err instanceof Error ? err.message : String(err)}`
            );
            return [] as ArticleResult[];
          }
        ));

    dbExcludedDomains = resolvedDbDomains;
    primaryDomains = resolvedPrimaryDomains;
    maxArticles = resolvedLimits.maxArticles;
    maxTokens = resolvedLimits.maxTokens;

    logger.log(
      `[article-search/articles] "${searchLabel}" [${entityType}][${phase}]: Serper=${serperResults.length} rå resultater`
    );

    rawResults = serperResults;
  } catch (err) {
    logger.error('[article-search/articles] Søgefejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
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

  // BIZZ-476: Når vi søger efter en virksomhed med CVR eller en person er det
  // per definition en dansk entitet. Drop resultater fra ikke-.dk-domæner
  // medmindre admin eksplicit har hvidlistet domænet i primaryDomains. Dette
  // filtrerer støjen fra internationale medier der matcher bogstavs-
  // kombinationen (fx HP Properties ApS fik tidligere indiske "HP-delstat"-
  // artikler fordi Serper gl:dk/hl:da ikke er nok til at undertrykke dem).
  const erDansk = Boolean(cvr) || isPerson;
  if (erDansk) {
    const foer = rawResults.length;
    rawResults = rawResults.filter((r) => isDkRelevant(r.url, primaryDomains));
    logger.log(
      `[article-search/articles] "${searchLabel}" DK-filter: ${foer} → ${rawResults.length} (droppede ikke-DK resultater)`
    );
  }

  logger.log(
    `[article-search/articles] "${searchLabel}" [${entityType}][${phase}]: ${rawResults.length} resultater efter dedup+filter`
  );

  // ── Raw-fase: returnér Serper-resultater direkte uden Claude ──
  // Foretrukne medier sorteres øverst, derefter sorterer frontenden efter dato.
  if (phase === 'raw') {
    const articles = sortByPrimaryDomains(rawResults.slice(0, 20), primaryDomains);
    return NextResponse.json({ articles, tokensUsed: 0, source: 'serper+raw', preliminary: true });
  }

  // Ingen resultater fra Serper — spring Claude over og returnér tomt
  if (rawResults.length === 0) {
    return NextResponse.json({ articles: [], tokensUsed: 0, source: 'serper+no-results' });
  }

  // ── Byg Claude-besked ──
  // Cap results to admin-configured max (default 40) to stay within token budget.
  const claudeResults = rawResults.slice(0, maxArticles);

  const resultSummary = claudeResults
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.date ? `\n   Dato: ${r.date}` : ''}${r.description ? `\n   Snippet: ${r.description}` : ''}`
    )
    .join('\n\n');

  // Byg kontekst og user-message afhængigt af entityType
  let userMessage: string;
  let systemPrompt: string;

  if (isPerson) {
    const personContext = [
      `Personens fulde navn: ${searchLabel}`,
      company ? `Tilknyttet virksomhed: ${company}` : null,
      city ? `By: ${city}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    userMessage = `Person:\n${personContext}\n\nSøgeresultater (${claudeResults.length} hits):\n\n${resultSummary}\n\nRangér og filtrer disse resultater — returner kun artikler der handler om DENNE person.`;
    systemPrompt = buildPersonArticlesSystemPrompt(primaryDomains);
  } else {
    const companyContext = [
      `Virksomhedsnavn: ${searchLabel}`,
      cvr ? `CVR-nummer: ${cvr}` : null,
      industry ? `Branche: ${industry}` : null,
      employees ? `Ansatte: ${employees}` : null,
      city ? `By: ${city}` : null,
      keyPersons?.length ? `Nøglepersoner: ${keyPersons.slice(0, 6).join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    userMessage = `Virksomhed:\n${companyContext}\n\nSøgeresultater (${claudeResults.length} hits):\n\n${resultSummary}\n\nRangér og filtrer disse resultater — returner kun artikler der handler om DENNE virksomhed.`;
    systemPrompt = buildArticlesSystemPrompt(primaryDomains);
  }

  // ── Kald Claude ──
  const client = new Anthropic({ apiKey: apiKey! });
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const totalTokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    const finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const claudeArticles = parseArticlesResponse(finalText);
    // Post-processing: sort programmatically so foretrukne medier altid er øverst.
    // Claude's rækkefølge inden for hver gruppe bevares.
    const articles = sortByPrimaryDomains(claudeArticles, primaryDomains);

    logger.log(
      `[article-search/articles] "${searchLabel}" [${entityType}][ai]: ${articles.length} artikler, tokens=${totalTokens}`
    );

    return NextResponse.json({
      articles,
      tokensUsed: totalTokens,
      source: 'serper+claude',
    });
  } catch (err) {
    logger.error('[article-search/articles] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl', articles: [] }, { status: 500 });
  }
}
