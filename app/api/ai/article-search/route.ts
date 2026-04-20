/**
 * POST /api/ai/article-search
 *
 * AI-drevet artikelsøgning for danske virksomheder med confidence-baseret link-scoring.
 *
 * Strategi:
 * 1. Brave Search API — henter op til 20 reelle artikler
 * 2. Claude — ranker, filtrerer og tilføjer confidence-scores til sociale medier-links
 * 3. Supabase — henter lærings-kontekst (verificerings-historik) og confidence-tærskel
 *
 * Confidence-flow:
 * - Claude returnerer confidence (0-100) for hvert primært link og hvert alternativ
 * - Primære links under tærsklen flyttes til alternativer og vises ikke
 * - Alternativer under tærsklen gemmes til Supabase men returneres med confidence-data
 *   så frontend kan filtrere dem fra visning
 *
 * Env vars:
 * - BRAVE_SEARCH_API_KEY          — Brave Search Subscription Token
 * - BIZZASSIST_CLAUDE_KEY         — Anthropic API-nøgle
 * - NEXT_PUBLIC_SUPABASE_URL      — Supabase projekt-URL
 * - SUPABASE_SERVICE_ROLE_KEY     — Supabase service-nøgle (til ai_settings + lærings-kontekst)
 *
 * @param body.companyName  - Virksomhedens navn
 * @param body.cvr          - CVR-nummer (valgfrit)
 * @param body.industry     - Branchebeskrivelse (valgfrit)
 * @param body.employees    - Antal ansatte (valgfrit)
 * @param body.city         - By (valgfrit)
 * @param body.keyPersons   - Nøglepersoner: direktører, bestyrelsesmedlemmer (valgfrit)
 * @returns { articles, socials, socialAlternatives, socialsWithMeta, alternativesWithMeta,
 *            confidenceThreshold, tokensUsed, usage, source }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, braveRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { BRAVE_SEARCH_ENDPOINT } from '@/app/lib/serviceEndpoints';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Ekskluderede domæner (konkurrenter) ─────────────────────────────────────

/**
 * Domæner der aldrig må vises som artikelresultater — konkurrenters platforme.
 * Filtreres fra Brave-resultater inden de sendes til Claude.
 */
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

// ─── Types ───────────────────────────────────────────────────────────────────

/** En nyhedsartikel */
interface ArticleResult {
  title: string;
  url: string;
  source: string;
  date?: string;
  description?: string;
}

/** Sociale medier og hjemmeside-links — primære URLs (backward compat) */
interface SocialsResult {
  website?: string;
  facebook?: string;
  linkedin?: string;
  instagram?: string;
  twitter?: string;
  youtube?: string;
}

/** Alternative links per platform (backward compat — string arrays) */
type SocialAlternativesResult = Record<string, string[]>;

/** Et socialt medie-link med confidence metadata */
interface SocialWithMeta {
  url: string;
  /** Confidence score 0-100: hvor sikker Claude er på at dette er det korrekte link */
  confidence: number;
  /** Begrundelse fra Claude */
  reason?: string;
}

/** Svar-format fra API'en */
interface ArticleSearchResponse {
  articles: ArticleResult[];
  /** Primære sociale medier-links — backward compat (kun links >= threshold) */
  socials: SocialsResult;
  /** Alternative links per platform — backward compat (alle alternativer som string[]) */
  socialAlternatives: SocialAlternativesResult;
  /** Primære links med confidence metadata — nyt format */
  socialsWithMeta: Record<string, SocialWithMeta>;
  /** Alternativer med confidence metadata per platform — nyt format */
  alternativesWithMeta: Record<string, SocialWithMeta[]>;
  /** Confidence-tærskel brugt til filtrering (hentet fra ai_settings) */
  confidenceThreshold: number;
  tokensUsed: number;
  usage: { totalTokens: number };
  source: 'brave+claude';
}

/** Input-format til API'en */
interface CompanyInput {
  companyName: string;
  cvr?: string;
  industry?: string;
  employees?: number | string;
  city?: string;
  keyPersons?: string[];
}

/** Et Brave Search web-resultat (råformat) */
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

/** Standard confidence-tærskel hvis Supabase ikke er tilgængeligt */
const DEFAULT_THRESHOLD = 70;

/**
 * Henter blokerede domæner fra ai_settings-tabellen.
 * Merger DB-listen med de hardcodede standarddomæner.
 * Returnerer de hardcodede standarddomæner hvis Supabase fejler.
 *
 * @returns Array af domæner der skal ekskluderes fra artikelresultater
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
      // Merger DB-domæner med hardcodede standarddomæner (union — ingen dubletter)
      const merged = new Set([...EXCLUDED_ARTICLE_DOMAINS, ...(data.value as string[])]);
      return Array.from(merged);
    }
    return EXCLUDED_ARTICLE_DOMAINS;
  } catch {
    return EXCLUDED_ARTICLE_DOMAINS;
  }
}

/**
 * Henter confidence-tærskel fra ai_settings-tabellen.
 * Returnerer DEFAULT_THRESHOLD hvis Supabase ikke er konfigureret eller fejler.
 *
 * @returns Confidence-tærskel som tal (0-100)
 */
async function fetchConfidenceThreshold(): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return DEFAULT_THRESHOLD;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await client
      .from('ai_settings')
      .select('value')
      .eq('key', 'min_confidence_threshold')
      .single();
    const val = Number(data?.value);
    return Number.isFinite(val) && val >= 0 && val <= 100 ? val : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

/**
 * Bygger lærings-kontekst fra aggregerede verificerings-data i Supabase.
 * Beregner godkendelsesrate per platform baseret på bruger-verificeringer på tværs af alle virksomheder.
 * Returnerer tom streng hvis Supabase ikke er konfigureret eller ingen data.
 *
 * @returns Formateret kontekst-streng til Claude's system prompt
 */
async function buildLearningContext(): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return '';
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Hent aggregerede verificeringer per platform
    const { data } = await client
      .from('link_verification_counts')
      .select('platform, link_url, verified_count, rejected_count')
      .not('platform', 'is', null);

    if (!data || data.length === 0) return '';

    // Aggregér per platform: total verified + rejected
    const platformStats: Record<string, { verified: number; rejected: number; total: number }> = {};
    for (const row of data) {
      const p = row.platform as string;
      if (!platformStats[p]) platformStats[p] = { verified: 0, rejected: 0, total: 0 };
      platformStats[p].verified += Number(row.verified_count) || 0;
      platformStats[p].rejected += Number(row.rejected_count) || 0;
      platformStats[p].total +=
        (Number(row.verified_count) || 0) + (Number(row.rejected_count) || 0);
    }

    // Byg kontekst-streng med godkendelsesrater per platform
    const lines: string[] = [];
    for (const [platform, stats] of Object.entries(platformStats)) {
      if (stats.total < 3) continue; // Ignorer platforme med for lidt data
      const rate = Math.round((stats.verified / stats.total) * 100);
      lines.push(
        `- ${platform}: ${rate}% godkendelsesrate (${stats.verified} verificeret, ${stats.rejected} afvist ud af ${stats.total} stemmer)`
      );
    }

    if (lines.length === 0) return '';

    return `\n\nLærings-kontekst fra bruger-verificeringer (brug til at kalibrere confidence-scores):\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

// ─── Brave Search ─────────────────────────────────────────────────────────────

/**
 * Søger via Brave Search API og returnerer rå artikelresultater.
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
  const url = `${BRAVE_SEARCH_ENDPOINT}?${params}`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brave Search HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawResults: BraveWebResult[] = data.web?.results ?? [];

  if (rawResults.length === 0) return [];

  const seen = new Set<string>();
  return rawResults
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
 * Søger artikler via to parallelle Brave-queries og merger resultater.
 *
 * @param key         - Brave Search Subscription Token
 * @param companyName - Virksomhedens navn
 */
async function searchBraveArticles(key: string, companyName: string): Promise<ArticleResult[]> {
  // Generel søgning — dækker anmeldelser, guides, omtaler, nyheder
  const query1 = `"${companyName}" anmeldelse OR artikel OR nyheder OR guide OR omtale`;
  // Bredt nyheds-søgning uden site:-begrænsning (relevant for mindre virksomheder)
  const query2 = `"${companyName}" nyheder artikel`;
  // Medievirksomheder (kun for større/kendte virksomheder — kører parallelt)
  const query3 = `"${companyName}" site:dr.dk OR site:tv2.dk OR site:borsen.dk OR site:berlingske.dk OR site:politiken.dk`;

  const [results1, results2, results3, resultsFresh] = await Promise.all([
    searchBrave(key, query1, 20),
    searchBrave(key, query2, 20),
    searchBrave(key, query3, 10),
    searchBrave(key, query1, 10, 'pm'), // Seneste måned — nyeste artikler
  ]);

  const seen = new Set<string>();
  const merged: ArticleResult[] = [];
  // Nyeste (fresh) og medievirksomheder prioriteres
  for (const r of [...resultsFresh, ...results3, ...results1, ...results2]) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      merged.push(r);
    }
  }

  logger.log(
    `[article-search] searchBraveArticles: q1=${results1.length} + q2=${results2.length} + q3=${results3.length} → merged=${merged.length}`
  );
  return merged;
}

/**
 * Søger sociale medier-profiler for en virksomhed via Brave Search.
 *
 * @param key         - Brave Search Subscription Token
 * @param companyName - Virksomhedens navn
 */
async function searchBraveSocials(key: string, companyName: string): Promise<SocialsResult> {
  const DIRECTORY_DOMAINS = [
    'krak.dk',
    'proff.dk',
    'yelp.com',
    'tripadvisor',
    'gulesider.dk',
    'cvr.dk',
    'virk.dk',
    'wikipedia.org',
    'facebook.com',
    'linkedin.com',
    'instagram.com',
    'youtube.com',
    'x.com',
    'twitter.com',
  ];

  const platforms: Array<{ name: keyof SocialsResult; query: string; count: number }> = [
    { name: 'website', query: `${companyName} officiel hjemmeside`, count: 3 },
    { name: 'facebook', query: `${companyName} site:facebook.com`, count: 1 },
    { name: 'instagram', query: `${companyName} site:instagram.com`, count: 1 },
    { name: 'linkedin', query: `${companyName} site:linkedin.com`, count: 1 },
    { name: 'twitter', query: `${companyName} site:x.com OR site:twitter.com`, count: 1 },
    { name: 'youtube', query: `${companyName} site:youtube.com`, count: 1 },
  ];

  const results = await Promise.allSettled(
    platforms.map(async (p) => {
      const url = `${BRAVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(p.query)}&count=${p.count}&country=dk`;
      const res = await fetch(url, {
        headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      const hits: BraveWebResult[] = data.web?.results ?? [];

      if (p.name === 'website') {
        const official = hits.find((h) => {
          const hostname = h.meta_url?.hostname ?? new URL(h.url).hostname;
          return !DIRECTORY_DOMAINS.some((d) => hostname.includes(d));
        });
        return { name: p.name, url: (official?.url as string) || null };
      }
      return { name: p.name, url: (hits[0]?.url as string) || null };
    })
  );

  const socials: SocialsResult = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.url) {
      socials[r.value.name] = r.value.url;
    }
  }

  logger.log(`[article-search] searchBraveSocials: fandt ${Object.keys(socials).length} platforme`);
  return socials;
}

// ─── System prompts ──────────────────────────────────────────────────────────

/**
 * Bygger system prompt til Brave+Claude-tilstand med confidence-scoring.
 * Inkluderer valgfri lærings-kontekst fra Supabase-verificeringer.
 *
 * @param learningContext - Aggregerede verificerings-statistikker per platform
 * @returns Komplet system prompt til Claude
 */
function buildSystemPrompt(learningContext: string): string {
  return `Du er en dansk medieekspert. Du modtager ALLE Brave Search-resultater om en virksomhed — ufiltrerede.

Din opgave er at kvalitetsvurdere hvert eneste resultat og returnere de bedste:
1. Vurdér om hvert hit handler om DENNE SPECIFIKKE virksomhed (ikke en anden med lignende navn)
2. Prioritér danske artikler, men inkludér internationale hvis de handler om virksomheden
3. Sortér artikler efter dato — NYESTE artikler FØRST. Prioritér artikler fra de seneste 30 dage over ældre artikler.
4. Forbedre snippet-beskrivelser til max 100 tegn dansk tekst hvis nødvendigt
5. Find virksomhedens sociale medier og hjemmeside-links — vurder confidence for hvert link

EKSKLUDEREDE DOMÆNER — inkludér ALDRIG artikler fra disse domæner (konkurrenter):
ownr.dk, estatistik.dk, profiler.dk, krak.dk, proff.dk, paqle.dk, erhvervplus.dk, lasso.dk, cvrapi.dk, find-virksomhed.dk, virksomhedskartoteket.dk, crunchbase.com, b2bhint.com, resights.dk

RELEVANCEREGLER — afvis et resultat hvis:
- Det handler om en ANDEN virksomhed med samme eller lignende navn
- Det er et jobopslag (stillingsopslag, karriere, ledige stillinger)
- Det er en generisk brancheportal eller aggregator der bare lister virksomheden
- Det er åbenlyst spam eller irrelevant indhold
- Det er en tom/generisk virksomhedsprofilside uden reel information
- Det stammer fra et af de ekskluderede domæner ovenfor

CONFIDENCE-REGLER for sociale medier:
- 90-100: Meget sikker — officielt domæne matcher eksakt, /company/ URL med korrekt slug, osv.
- 75-89: Ret sikker — stærke indikatorer men ikke perfekt match
- 60-74: Usikkert — delvist match, kan potentielt være forkert
- Under 60: Meget usikkert — kun et gæt baseret på minimal information
- Gæt IKKE URLs — returner kun links du kender med rimelig sikkerhed (confidence >= 50)
- Returner ALDRIG generiske roddomæner (f.eks. "https://facebook.com/") — kun specifikke profil-URLs${learningContext}

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
  ],
  "socials": {
    "website": {
      "url": "https://virksomhed.dk",
      "confidence": 95,
      "reason": "Officielt domæne matcher virksomhedsnavnet eksakt",
      "alternatives": [
        {"url": "https://www.virksomhed.dk", "confidence": 75, "reason": "Alternativt www-præfiks"}
      ]
    },
    "linkedin": {
      "url": "https://www.linkedin.com/company/slug",
      "confidence": 88,
      "reason": "LinkedIn /company/ URL med navn der matcher CVR-virksomhed",
      "alternatives": []
    },
    "facebook": {
      "url": "https://www.facebook.com/slug",
      "confidence": 72,
      "reason": "Profilnavn ligner virksomhedsnavnet men ikke eksakt match",
      "alternatives": [
        {"url": "https://www.facebook.com/altslug", "confidence": 55, "reason": "Muligt alternativ"}
      ]
    }
  }
}

Regler for "socials":
- Udelad platforme du ikke kender (udelad feltet helt — returner ikke null eller tomt objekt)
- Returner altid "socials"-objektet (evt. tomt {})
- "alternatives"-arrayet kan være tomt [] men skal altid inkluderes for platforme du returnerer
- Ret IKKE URLs fra Brave — brug præcis de URLs fra Brave-resultaterne til artikler
- Opfind IKKE nye artikel-URLs — brug KUN de givne Brave-resultater`;
}

// ─── Response parser ─────────────────────────────────────────────────────────

/**
 * Sociale medier-domæner der skal filtreres fra artikellisten
 * hvis de matcher et fundet socialt medie-link.
 */
const SOCIAL_DOMAINS = [
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
];

/**
 * Returnerer true hvis URL'ens domæne er et socialt medie-domæne.
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
 * Returnerer true hvis to URLs tilhører samme base-domæne.
 *
 * @param url1 - Primær URL
 * @param url2 - Alternativ URL
 */
function isSameBaseDomain(url1: string, url2: string): boolean {
  try {
    const base = (u: string) =>
      new URL(u).hostname.replace(/^www\./, '').replace(/\.(dk|com|org|net|io)$/, '');
    return base(url1) === base(url2);
  } catch {
    return false;
  }
}

/**
 * Validerer at en streng er en gyldig URL med https:// eller http://.
 *
 * @param url - URL der skal valideres
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return url.startsWith('https://') || url.startsWith('http://');
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
 * Parser Claude's JSON-svar med artikelliste og sociale medier inkl. confidence-scores.
 * Understøtter nyt format ({ url, confidence, reason, alternatives[] }) samt
 * gammelt format ({ primary, alternatives[] }) for bagudkompatibilitet.
 *
 * @param text       - Rå tekstsvar fra Claude
 * @param threshold  - Confidence-tærskel: primære links under denne score flyttes til alternativer
 * @returns Parsede artikler, socials, socialAlternatives (compat), socialsWithMeta, alternativesWithMeta
 */
function parseArticleResponse(
  text: string,
  threshold: number
): {
  articles: ArticleResult[];
  socials: SocialsResult;
  socialAlternatives: SocialAlternativesResult;
  socialsWithMeta: Record<string, SocialWithMeta>;
  alternativesWithMeta: Record<string, SocialWithMeta[]>;
} {
  const empty = {
    articles: [],
    socials: {},
    socialAlternatives: {},
    socialsWithMeta: {},
    alternativesWithMeta: {},
  };

  try {
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ??
      text.match(/```\s*([\s\S]*?)\s*```/) ??
      text.match(/(\{[\s\S]*\})/);

    if (!jsonMatch) return empty;

    const raw = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);

    // ── Artikler ──
    const rawArticles: unknown[] = Array.isArray(raw.articles) ? raw.articles : [];
    const articles: ArticleResult[] = rawArticles
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
          typeof a.description === 'string'
            ? String(a.description).trim().slice(0, 100)
            : undefined,
      }))
      .filter((a) => a.title && a.url)
      .sort((a, b) => parseDateForSort(b.date) - parseDateForSort(a.date));

    // ── Sociale medier med confidence ──
    const rawSocials = raw.socials ?? {};
    const socials: SocialsResult = {};
    const socialAlternatives: SocialAlternativesResult = {};
    const socialsWithMeta: Record<string, SocialWithMeta> = {};
    const alternativesWithMeta: Record<string, SocialWithMeta[]> = {};

    const socialKeys = ['website', 'facebook', 'linkedin', 'instagram', 'twitter', 'youtube'];

    for (const key of socialKeys) {
      const val = rawSocials[key];
      if (!val || typeof val !== 'object') continue;

      const entry = val as Record<string, unknown>;

      // Udtræk primær URL — understøtter nyt format (url) og gammelt format (primary)
      const primaryUrl =
        typeof entry.url === 'string' && isValidUrl(entry.url)
          ? entry.url.trim()
          : typeof entry.primary === 'string' && isValidUrl(entry.primary)
            ? entry.primary.trim()
            : null;

      if (!primaryUrl) continue;

      const confidence =
        typeof entry.confidence === 'number'
          ? Math.max(0, Math.min(100, Math.round(entry.confidence)))
          : 80; // Fallback confidence hvis ikke angivet

      const reason = typeof entry.reason === 'string' ? entry.reason.trim() : undefined;

      // Udtræk alternativer — nyt format: [{ url, confidence, reason }], gammelt: [string]
      const rawAlts: unknown[] = Array.isArray(entry.alternatives) ? entry.alternatives : [];
      const altsWithMeta: SocialWithMeta[] = rawAlts
        .map((a): SocialWithMeta | null => {
          if (typeof a === 'string' && isValidUrl(a)) {
            return { url: a.trim(), confidence: 75, reason: undefined };
          }
          if (typeof a === 'object' && a !== null) {
            const ao = a as Record<string, unknown>;
            const url = typeof ao.url === 'string' ? ao.url.trim() : '';
            if (!url || !isValidUrl(url)) return null;
            return {
              url,
              confidence:
                typeof ao.confidence === 'number'
                  ? Math.max(0, Math.min(100, Math.round(ao.confidence)))
                  : 75,
              reason: typeof ao.reason === 'string' ? ao.reason.trim() : undefined,
            };
          }
          return null;
        })
        .filter((a): a is SocialWithMeta => a !== null)
        // Fjern alternativer med samme base-domæne som primær
        .filter((a) => a.url !== primaryUrl && !isSameBaseDomain(a.url, primaryUrl))
        .slice(0, 5);

      if (confidence >= threshold) {
        // Primært link er over tærsklen — vis det
        socials[key as keyof SocialsResult] = primaryUrl;
        socialsWithMeta[key] = { url: primaryUrl, confidence, reason };
      } else {
        // Primært link er under tærsklen — flyt til alternativer
        altsWithMeta.unshift({ url: primaryUrl, confidence, reason });
        logger.log(
          `[article-search] ${key}: primær URL "${primaryUrl}" under tærskel (${confidence} < ${threshold}) — flyttes til alternativer`
        );
      }

      // Gem alle alternativer (inkl. dem under tærskel — frontend filtrerer til visning)
      if (altsWithMeta.length > 0) {
        alternativesWithMeta[key] = altsWithMeta;
        // Backward compat: string-array med alle alternativer
        socialAlternatives[key] = altsWithMeta.map((a) => a.url);
      }
    }

    // ── Filtrer artikler der matcher sociale medie-domæner ──
    // Sociale medier-links vises i "socials"-sektionen — aldrig som artikler.
    const filteredArticles = articles.filter((a) => !isSocialDomain(a.url));

    return {
      articles: filteredArticles,
      socials,
      socialAlternatives,
      socialsWithMeta,
      alternativesWithMeta,
    };
  } catch {
    return empty;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/article-search
 * Søger artikler og sociale medier om en virksomhed med confidence-scoring.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, braveRateLimit);
  if (limited) return limited;
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // BIZZ-649: Central AI billing-gate. Blokerer brugere uden budget før
  // Anthropic-kald gennemføres.
  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });
  }

  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!braveKey) {
    return NextResponse.json({ error: 'BRAVE_SEARCH_API_KEY ikke konfigureret' }, { status: 500 });
  }

  let body: CompanyInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { companyName, cvr, industry, employees, city, keyPersons } = body;
  if (!companyName?.trim()) {
    return NextResponse.json({ error: 'companyName er påkrævet' }, { status: 400 });
  }

  // ── Hent threshold + lærings-kontekst + Brave-data + ekskluderede domæner parallelt ──
  let braveResults: ArticleResult[];
  let braveSocials: SocialsResult;
  let confidenceThreshold: number;
  let learningContext: string;
  let dbExcludedDomains: string[];

  try {
    [braveResults, braveSocials, confidenceThreshold, learningContext, dbExcludedDomains] =
      await Promise.all([
        searchBraveArticles(braveKey, companyName),
        searchBraveSocials(braveKey, companyName),
        fetchConfidenceThreshold(),
        buildLearningContext(),
        fetchExcludedDomains(),
      ]);
  } catch (err) {
    logger.error('[article-search] Initialiseringsfejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }

  // Anvend DB-baserede ekskluderede domæner som ekstra filtrering oven på hardcodet liste
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
    `[article-search] "${companyName}": Brave=${braveResults.length} rå resultater, threshold=${confidenceThreshold}`
  );

  // ── Byg virksomhedskontekst og bruger-besked ─────────────────────────────
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

  const braveSummary =
    braveResults.length > 0
      ? braveResults
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.date ? `\n   Dato: ${r.date}` : ''}${r.description ? `\n   Snippet: ${r.description}` : ''}`
          )
          .join('\n\n')
      : '(Ingen Brave-resultater for denne søgning)';

  let socialVerificationSection = '';
  if (Object.keys(braveSocials).length > 0) {
    const socialsStr = Object.entries(braveSocials)
      .map(([platform, url]) => `- ${platform}: ${url}`)
      .join('\n');
    const locationHint = city ? ` i ${city}` : ' i Danmark';
    socialVerificationSection =
      `\n\nBrave Search har fundet disse sociale medie-profiler — verificer om de tilhører NETOP DENNE virksomhed${locationHint}:\n${socialsStr}\n` +
      `Brug dem i din socials-output med passende confidence-score hvis de er korrekte. Hvis en profil tilhører en anden virksomhed, giv den lav confidence eller udelad den.`;
  }

  const userMessage =
    `Virksomhed:\n${companyContext}\n\nBrave Search-resultater (${braveResults.length} hits):\n\n${braveSummary}\n\nRangér og filtrer disse resultater. Find også sociale medier-links med confidence-scores.` +
    socialVerificationSection;

  // ── Kald Claude ──────────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt(learningContext);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const totalInputTokens = response.usage?.input_tokens ?? 0;
    const totalOutputTokens = response.usage?.output_tokens ?? 0;
    const totalTokens = totalInputTokens + totalOutputTokens;

    const finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const {
      articles,
      socials: claudeSocials,
      socialAlternatives,
      socialsWithMeta,
      alternativesWithMeta,
    } = parseArticleResponse(finalText, confidenceThreshold);

    // Claude's kvalitetssikrede links overskriver Brave-fund
    const socials: SocialsResult = { ...braveSocials, ...claudeSocials };

    logger.log(
      `[article-search] "${companyName}": ${articles.length} artikler, tokens=${totalTokens}, ` +
        `primære links=[${Object.keys(socialsWithMeta).join(',')}], ` +
        `alternativer=[${Object.keys(alternativesWithMeta).join(',')}], threshold=${confidenceThreshold}`
    );

    if (articles.length === 0) {
      logger.warn('[article-search] Ingen artikler parsede. Råsvar:', finalText.slice(0, 500));
    }

    const result: ArticleSearchResponse = {
      articles,
      socials,
      socialAlternatives,
      socialsWithMeta,
      alternativesWithMeta,
      confidenceThreshold,
      tokensUsed: totalTokens,
      usage: { totalTokens },
      source: 'brave+claude',
    };

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    logger.error('[article-search] Fejl:', err);
    return NextResponse.json(
      { error: 'Ekstern API fejl', articles: [], usage: { totalTokens: 0 } },
      { status: 500 }
    );
  }
}
