/**
 * POST /api/ai/person-article-search
 *
 * AI-drevet artikelsøgning for danske personer med confidence-baseret link-scoring.
 *
 * Strategi:
 * 1. Brave Search API — søger artikler om personen + virksomheder personen ejer
 * 2. Claude — ranker, filtrerer og tilføjer confidence-scores til sociale medier-links
 * 3. Supabase — henter lærings-kontekst (verificerings-historik) og confidence-tærskel
 *
 * Søge-hierarki:
 * - Primær: Artikler om personen selv (personens fulde navn)
 * - Sekundær: Artikler om virksomheder i personens ejer-portefølje (top 3)
 * - Sociale medier: Personens LinkedIn-profil (/in/), Facebook, Instagram, X/Twitter
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
 * @param body.personName    - Personens fulde navn
 * @param body.companies     - Virksomheder personen ejer/leder: { cvr, name }[]
 * @param body.city          - By (valgfrit, til disambiguation)
 * @returns { articles, socials, socialAlternatives, socialsWithMeta, alternativesWithMeta,
 *            confidenceThreshold, tokensUsed, usage, source }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { rateLimit, AI_CHAT_LIMIT } from '@/app/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ────────────────────────────────────────────────────────────────────

/** En nyhedsartikel */
interface ArticleResult {
  title: string;
  url: string;
  source: string;
  date?: string;
  description?: string;
}

/** Sociale medier og hjemmeside-links — primære URLs */
interface SocialsResult {
  website?: string;
  facebook?: string;
  linkedin?: string;
  instagram?: string;
  twitter?: string;
}

/** Alternative links per platform */
type SocialAlternativesResult = Record<string, string[]>;

/** Et socialt medie-link med confidence metadata */
interface SocialWithMeta {
  url: string;
  /** Confidence score 0-100 */
  confidence: number;
  /** Begrundelse fra Claude */
  reason?: string;
}

/** Svar-format fra API'en */
interface ArticleSearchResponse {
  articles: ArticleResult[];
  socials: SocialsResult;
  socialAlternatives: SocialAlternativesResult;
  socialsWithMeta: Record<string, SocialWithMeta>;
  alternativesWithMeta: Record<string, SocialWithMeta[]>;
  confidenceThreshold: number;
  tokensUsed: number;
  usage: { totalTokens: number };
  source: 'brave+claude';
}

/** Input-format til API'en */
interface PersonInput {
  personName: string;
  companies?: Array<{ cvr: number | string; name: string }>;
  city?: string;
}

/** Et Brave Search web-resultat */
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
 * Beregner godkendelsesrate per platform baseret på bruger-verificeringer.
 *
 * @returns Formateret kontekst-streng til Claude's system prompt
 */
async function buildLearningContext(): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return '';
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await client
      .from('link_verification_counts')
      .select('platform, link_url, verified_count, rejected_count')
      .not('platform', 'is', null);

    if (!data || data.length === 0) return '';

    const platformStats: Record<string, { verified: number; rejected: number; total: number }> = {};
    for (const row of data) {
      const p = row.platform as string;
      if (!platformStats[p]) platformStats[p] = { verified: 0, rejected: 0, total: 0 };
      platformStats[p].verified += Number(row.verified_count) || 0;
      platformStats[p].rejected += Number(row.rejected_count) || 0;
      platformStats[p].total +=
        (Number(row.verified_count) || 0) + (Number(row.rejected_count) || 0);
    }

    const lines: string[] = [];
    for (const [platform, stats] of Object.entries(platformStats)) {
      if (stats.total < 3) continue;
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
 * Søger via Brave Search API og returnerer rå web-resultater.
 *
 * @param key   - Brave Search Subscription Token
 * @param query - Søgeforespørgsel
 * @param count - Antal resultater (max 20 pr. kald)
 */
async function searchBrave(key: string, query: string, count = 20): Promise<ArticleResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&country=dk`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
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
    .filter((r) => r.title && r.url);
}

/**
 * Søger artikler om en person og deres virksomheder via parallelle Brave-queries.
 * Primær: personens fulde navn. Sekundær: top 3 virksomheder personen ejer.
 *
 * @param key        - Brave Search Subscription Token
 * @param personName - Personens fulde navn
 * @param companies  - Top virksomheder personen ejer (max 3 bruges)
 */
async function searchBravePersonArticles(
  key: string,
  personName: string,
  companies: Array<{ cvr: number | string; name: string }>
): Promise<ArticleResult[]> {
  // Primær: artikler om personen
  const query1 = `"${personName}" nyheder artikel`;
  const query2 = `"${personName}" site:dr.dk OR site:tv2.dk OR site:borsen.dk OR site:berlingske.dk OR site:politiken.dk`;

  // Sekundær: top 3 ejervirksomheder
  const topCompanies = companies.slice(0, 3);
  const companyQueries = topCompanies.map((c) => `"${c.name}" "${personName}"`);

  const queries: Promise<ArticleResult[]>[] = [
    searchBrave(key, query1, 20),
    searchBrave(key, query2, 10),
    ...companyQueries.map((q) => searchBrave(key, q, 5)),
  ];

  const results = await Promise.allSettled(queries);

  const allResults: ArticleResult[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allResults.push(...r.value);
  }

  // Deduplikér og person-resultater prioriteres
  const seen = new Set<string>();
  const merged: ArticleResult[] = [];
  for (const r of allResults) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      merged.push(r);
    }
  }

  console.log(
    `[person-article-search] searchBravePersonArticles: ${merged.length} merged resultater for "${personName}"`
  );
  return merged;
}

/**
 * Søger personens sociale medier-profiler via Brave Search.
 * Bruger personlig profil-format (/in/ på LinkedIn) i stedet for virksomhedsprofil.
 *
 * @param key        - Brave Search Subscription Token
 * @param personName - Personens fulde navn
 */
async function searchBravePersonSocials(key: string, personName: string): Promise<SocialsResult> {
  const platforms: Array<{ name: keyof SocialsResult; query: string; count: number }> = [
    { name: 'linkedin', query: `"${personName}" site:linkedin.com/in`, count: 2 },
    { name: 'facebook', query: `"${personName}" site:facebook.com`, count: 2 },
    { name: 'instagram', query: `"${personName}" site:instagram.com`, count: 1 },
    { name: 'twitter', query: `"${personName}" site:x.com OR site:twitter.com`, count: 1 },
  ];

  const results = await Promise.allSettled(
    platforms.map(async (p) => {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(p.query)}&count=${p.count}&country=dk`;
      const res = await fetch(url, {
        headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      const hits: BraveWebResult[] = data.web?.results ?? [];
      return { name: p.name, url: (hits[0]?.url as string) || null };
    })
  );

  const socials: SocialsResult = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.url) {
      socials[r.value.name] = r.value.url;
    }
  }

  console.log(
    `[person-article-search] searchBravePersonSocials: fandt ${Object.keys(socials).length} platforme`
  );
  return socials;
}

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Bygger system prompt til person-søgning med confidence-scoring.
 * Fokuserer på personlige profiler (LinkedIn /in/) frem for virksomhedsprofiler.
 *
 * @param learningContext - Aggregerede verificerings-statistikker per platform
 * @returns Komplet system prompt til Claude
 */
function buildPersonSystemPrompt(learningContext: string): string {
  return `Du er en dansk medieekspert. Du modtager ALLE Brave Search-resultater om en dansk person — ufiltrerede.

Din opgave er at kvalitetsvurdere hvert eneste resultat og returnere de bedste:
1. Vurdér om hvert hit handler om DENNE SPECIFIKKE PERSON (ikke en anden med samme navn)
2. Prioritér artikler der nævner personens fulde navn og helst kontekst (virksomhed, by, branche)
3. Sortér med nyeste/vigtigste først
4. Forbedre snippet-beskrivelser til max 100 tegn dansk tekst hvis nødvendigt
5. Find personens sociale medier-profiler — VIGTIGT: søg efter PERSONLIG profil (LinkedIn /in/), ikke virksomhedsprofil

RELEVANCEREGLER — afvis et resultat hvis:
- Det handler om en ANDEN person med samme navn
- Det er et jobopslag for en stilling personen ikke har nævneværdig tilknytning til
- Det er en generisk telefonbog/adressebog-side uden reel information
- Det er åbenlyst spam eller irrelevant indhold

CONFIDENCE-REGLER for sociale medier (PERSON-specifik):
- 90-100: Meget sikker — LinkedIn /in/ profil med personens fulde navn eksakt, billede matcher mv.
- 75-89: Ret sikker — stærkt navnematch og korrekt by/virksomhedskontext
- 60-74: Usikkert — delvist match, muligvis en anden med samme navn
- Under 60: Meget usikkert — kun et gæt
- Returner KUN LinkedIn-profiler med /in/ (ikke /company/) — disse er personlige profiler
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
    "linkedin": {
      "url": "https://www.linkedin.com/in/personens-slug",
      "confidence": 88,
      "reason": "LinkedIn /in/ profil med fuldt navn-match og dansk by",
      "alternatives": []
    },
    "facebook": {
      "url": "https://www.facebook.com/slug",
      "confidence": 72,
      "reason": "Profil med navn der matcher",
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

// ─── Response parser ──────────────────────────────────────────────────────────

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
 * Parser Claude's JSON-svar med artikelliste og sociale medier inkl. confidence-scores.
 *
 * @param text       - Rå tekstsvar fra Claude
 * @param threshold  - Confidence-tærskel: primære links under denne score flyttes til alternativer
 * @returns Parsede artikler, socials, socialAlternatives, socialsWithMeta, alternativesWithMeta
 */
function parsePersonArticleResponse(
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
      .filter((a) => a.title && a.url);

    // ── Sociale medier med confidence ──
    const rawSocials = raw.socials ?? {};
    const socials: SocialsResult = {};
    const socialAlternatives: SocialAlternativesResult = {};
    const socialsWithMeta: Record<string, SocialWithMeta> = {};
    const alternativesWithMeta: Record<string, SocialWithMeta[]> = {};

    const socialKeys = ['website', 'facebook', 'linkedin', 'instagram', 'twitter'];

    for (const key of socialKeys) {
      const val = rawSocials[key];
      if (!val || typeof val !== 'object') continue;

      const entry = val as Record<string, unknown>;

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
          : 80;

      const reason = typeof entry.reason === 'string' ? entry.reason.trim() : undefined;

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
        .filter((a) => a.url !== primaryUrl && !isSameBaseDomain(a.url, primaryUrl))
        .slice(0, 5);

      if (confidence >= threshold) {
        socials[key as keyof SocialsResult] = primaryUrl;
        socialsWithMeta[key] = { url: primaryUrl, confidence, reason };
      } else {
        altsWithMeta.unshift({ url: primaryUrl, confidence, reason });
        console.log(
          `[person-article-search] ${key}: primær URL "${primaryUrl}" under tærskel (${confidence} < ${threshold}) — flyttes til alternativer`
        );
      }

      if (altsWithMeta.length > 0) {
        alternativesWithMeta[key] = altsWithMeta;
        socialAlternatives[key] = altsWithMeta.map((a) => a.url);
      }
    }

    return { articles, socials, socialAlternatives, socialsWithMeta, alternativesWithMeta };
  } catch {
    return empty;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/person-article-search
 * Søger artikler og sociale medier om en person med confidence-scoring.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = rateLimit(request, AI_CHAT_LIMIT);
  if (limited) return NextResponse.json({ error: 'Rate limit overskredet' }, { status: 429 });

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });
  }

  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!braveKey) {
    return NextResponse.json({ error: 'BRAVE_SEARCH_API_KEY ikke konfigureret' }, { status: 500 });
  }

  let body: PersonInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { personName, companies = [], city } = body;
  if (!personName?.trim()) {
    return NextResponse.json({ error: 'personName er påkrævet' }, { status: 400 });
  }

  // ── Hent threshold + lærings-kontekst + Brave-data parallelt ────────────
  let braveResults: ArticleResult[];
  let braveSocials: SocialsResult;
  let confidenceThreshold: number;
  let learningContext: string;

  try {
    [braveResults, braveSocials, confidenceThreshold, learningContext] = await Promise.all([
      searchBravePersonArticles(braveKey, personName, companies),
      searchBravePersonSocials(braveKey, personName),
      fetchConfidenceThreshold(),
      buildLearningContext(),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt Brave Search fejl';
    console.error('[person-article-search] Initialiseringsfejl:', msg);
    return NextResponse.json({ error: `Søgning fejlede: ${msg}` }, { status: 502 });
  }

  console.log(
    `[person-article-search] "${personName}": Brave=${braveResults.length} rå resultater, threshold=${confidenceThreshold}`
  );

  // ── Byg person-kontekst og bruger-besked ─────────────────────────────────
  const personContext = [
    `Personens fulde navn: ${personName}`,
    city ? `By: ${city}` : null,
    companies.length > 0
      ? `Virksomheder (ejer/leder): ${companies
          .slice(0, 5)
          .map((c) => `${c.name} (CVR ${c.cvr})`)
          .join(', ')}`
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

  let socialVerificationSection = '';
  if (Object.keys(braveSocials).length > 0) {
    const socialsStr = Object.entries(braveSocials)
      .map(([platform, url]) => `- ${platform}: ${url}`)
      .join('\n');
    const locationHint = city ? ` i ${city}` : ' i Danmark';
    socialVerificationSection =
      `\n\nBrave Search har fundet disse sociale medie-profiler — verificer om de tilhører NETOP DENNE PERSON${locationHint}:\n${socialsStr}\n` +
      `Brug dem i din socials-output med passende confidence-score. Hvis en profil tilhører en anden person, giv den lav confidence eller udelad den.`;
  }

  const userMessage =
    `Person:\n${personContext}\n\nBrave Search-resultater (${braveResults.length} hits):\n\n${braveSummary}\n\nRangér og filtrer disse resultater. Find også personens sociale medier-links med confidence-scores.` +
    socialVerificationSection;

  // ── Kald Claude ──────────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey });
  const systemPrompt = buildPersonSystemPrompt(learningContext);

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
    } = parsePersonArticleResponse(finalText, confidenceThreshold);

    // Claude's kvalitetssikrede links overskriver Brave-fund
    const socials: SocialsResult = { ...braveSocials, ...claudeSocials };

    console.log(
      `[person-article-search] "${personName}": ${articles.length} artikler, tokens=${totalTokens}, ` +
        `primære links=[${Object.keys(socialsWithMeta).join(',')}], ` +
        `alternativer=[${Object.keys(alternativesWithMeta).join(',')}], threshold=${confidenceThreshold}`
    );

    if (articles.length === 0) {
      console.warn(
        '[person-article-search] Ingen artikler parsede. Råsvar:',
        finalText.slice(0, 500)
      );
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
    console.error('[person-article-search] Fejl:', err);
    const errorMsg =
      err instanceof Anthropic.APIError
        ? `API-fejl (${err.status}): ${err.message}`
        : err instanceof Error
          ? err.message
          : 'Ukendt fejl';
    return NextResponse.json(
      { error: errorMsg, articles: [], usage: { totalTokens: 0 } },
      { status: 500 }
    );
  }
}
