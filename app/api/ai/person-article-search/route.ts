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

/** En kontaktoplysning fundet via AI */
interface ContactResult {
  address?: string;
  phone?: string;
  email?: string;
  source: string;
  sourceUrl: string;
  confidence: number;
  reason?: string;
}

/** Svar-format fra API'en */
interface ArticleSearchResponse {
  articles: ArticleResult[];
  socials: SocialsResult;
  socialAlternatives: SocialAlternativesResult;
  socialsWithMeta: Record<string, SocialWithMeta>;
  alternativesWithMeta: Record<string, SocialWithMeta[]>;
  contacts: ContactResult[];
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
 * @param key              - Brave Search Subscription Token
 * @param query            - Søgeforespørgsel
 * @param count            - Antal resultater (max 20 pr. kald)
 * @param skipDomainFilter - Spring ekskluderede domæner over (bruges til kontakt-søgning)
 */
async function searchBrave(
  key: string,
  query: string,
  count = 20,
  skipDomainFilter = false
): Promise<ArticleResult[]> {
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
    .filter((r) => r.title && r.url)
    .filter((r) => skipDomainFilter || !isExcludedDomain(r.url));
}

/**
 * Søger artikler om en person og deres virksomheder via parallelle Brave-queries.
 * Primær: personens fulde navn. Sekundær: top 5 ejervirksomheder (krydshenvisninger + egne nyheder).
 *
 * @param key        - Brave Search Subscription Token
 * @param personName - Personens fulde navn
 * @param companies  - Top virksomheder personen ejer (max 5 bruges)
 */
async function searchBravePersonArticles(
  key: string,
  personName: string,
  companies: Array<{ cvr: number | string; name: string }>
): Promise<ArticleResult[]> {
  // Primær: artikler om personen
  const query1 = `"${personName}" nyheder artikel`;
  const query2 = `"${personName}" site:dr.dk OR site:tv2.dk OR site:borsen.dk OR site:berlingske.dk OR site:politiken.dk`;

  // Sekundær: top 5 ejervirksomheder — tre queries per virksomhed:
  // 1. Krydshenvisning: kræver BEGGE navne i artiklen
  // 2. Selvstændig: generelle nyheder + anmeldelser + guides (inkluderer mindre virksomheder)
  // 3. Bred søgning uden site:-begrænsning (fanger lokale medier, blogger, TripAdvisor-lignende)
  const topCompanies = companies.slice(0, 5);
  const companyQueries = topCompanies.flatMap((c) => [
    `"${c.name}" "${personName}"`,
    `"${c.name}" anmeldelse OR artikel OR nyheder OR guide OR omtale`,
    `"${c.name}" nyheder artikel`,
  ]);

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
 * Udtrækker en kortere navnevariant ved at fjerne mellemnavne.
 * "Vicki Hornebo Larsen" → "Vicki Larsen"
 *
 * @param fullName - Personens fulde navn
 * @returns Fornavn + efternavn (uden mellemnavne), eller fuldt navn hvis <= 2 ord
 */
function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 2) return fullName;
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

/**
 * Søger én platform på Brave og returnerer unikke profil-URLs fra resultater.
 * Filtrerer ekskluderede domæner fra.
 * Hvis domainFilter er sat, returneres kun URLs der matcher det pågældende domæne.
 *
 * @param key          - Brave Search Subscription Token
 * @param query        - Søgeforespørgsel
 * @param count        - Antal resultater ønsket
 * @param domainFilter - Valgfrit domæne-filter (f.eks. "facebook.com") — filtrerer andre domæner fra
 */
async function searchBraveSocialPlatform(
  key: string,
  query: string,
  count: number,
  domainFilter?: string
): Promise<string[]> {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&country=dk`;
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    const hits: BraveWebResult[] = data.web?.results ?? [];
    return hits
      .map((h) => h.url as string)
      .filter((u) => {
        if (!u || isExcludedDomain(u)) return false;
        if (domainFilter) {
          try {
            const hostname = new URL(u).hostname.replace(/^www\./, '');
            return hostname === domainFilter || hostname.endsWith(`.${domainFilter}`);
          } catch {
            return false;
          }
        }
        return true;
      });
  } catch {
    return [];
  }
}

/**
 * Søger personens sociale medier-profiler via Brave Search.
 * Kører TO søgninger parallelt per platform:
 * 1. Direkte: `"navn" site:platform.com` — ramler direkte profil-indeksering
 * 2. Indirekte: `"navn" Platform` — finder profiler via tredje-parts links/omtaler
 * Begge navnevarianter (fuldt + kort) køres for alle queries.
 *
 * @param key        - Brave Search Subscription Token
 * @param personName - Personens fulde navn
 */
async function searchBravePersonSocials(
  key: string,
  personName: string
): Promise<{ socials: SocialsResult; allCandidates: Record<string, string[]> }> {
  const short = shortName(personName);
  const hasMiddleName = short !== personName;

  // Søgeforespørgsler per platform — direkte + indirekte + navnevarianter.
  // "direct" queries bruger site:-filter og returnerer alle URLs.
  // "indirect" queries returnerer kun URLs der matcher platform-domænet (domainFilter).
  type QueryDef = { query: string; domainFilter?: string };
  type PlatformDef = { name: keyof SocialsResult; queries: QueryDef[]; count: number };
  const platforms: PlatformDef[] = [
    {
      name: 'linkedin',
      queries: [
        // Direkte
        { query: `"${personName}" site:linkedin.com/in` },
        ...(hasMiddleName ? [{ query: `"${short}" site:linkedin.com/in` }] : []),
        // Indirekte — filtrerer til kun linkedin.com URLs i resultaterne
        { query: `"${personName}" LinkedIn`, domainFilter: 'linkedin.com' },
        ...(hasMiddleName ? [{ query: `"${short}" LinkedIn`, domainFilter: 'linkedin.com' }] : []),
      ],
      count: 3,
    },
    {
      name: 'facebook',
      queries: [
        // Direkte
        { query: `"${personName}" site:facebook.com` },
        ...(hasMiddleName ? [{ query: `"${short}" site:facebook.com` }] : []),
        // Indirekte
        { query: `"${personName}" Facebook`, domainFilter: 'facebook.com' },
        ...(hasMiddleName ? [{ query: `"${short}" Facebook`, domainFilter: 'facebook.com' }] : []),
      ],
      count: 3,
    },
    {
      name: 'instagram',
      queries: [
        // Direkte
        { query: `"${personName}" site:instagram.com` },
        ...(hasMiddleName ? [{ query: `"${short}" site:instagram.com` }] : []),
        // Indirekte
        { query: `"${personName}" Instagram`, domainFilter: 'instagram.com' },
        ...(hasMiddleName
          ? [{ query: `"${short}" Instagram`, domainFilter: 'instagram.com' }]
          : []),
      ],
      count: 2,
    },
    {
      name: 'twitter',
      queries: [
        // Direkte
        { query: `"${personName}" site:x.com OR site:twitter.com` },
        ...(hasMiddleName ? [{ query: `"${short}" site:x.com OR site:twitter.com` }] : []),
        // Indirekte — filtrerer til x.com eller twitter.com
        { query: `"${personName}" Twitter`, domainFilter: 'x.com' },
        ...(hasMiddleName ? [{ query: `"${short}" Twitter`, domainFilter: 'x.com' }] : []),
      ],
      count: 2,
    },
  ];

  // Kør alle queries parallelt på tværs af alle platforme
  const allQueries = platforms.flatMap((p) =>
    p.queries.map((qd) => ({
      platform: p.name,
      query: qd.query,
      count: p.count,
      domainFilter: qd.domainFilter,
    }))
  );

  const queryResults = await Promise.allSettled(
    allQueries.map(({ query, count, domainFilter }) =>
      searchBraveSocialPlatform(key, query, count, domainFilter)
    )
  );

  // Merge resultater per platform — behold første fund per platform (bedste match)
  const platformUrls: Partial<Record<keyof SocialsResult, string[]>> = {};
  let qi = 0;
  for (const p of platforms) {
    const urls: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < p.queries.length; i++) {
      const r = queryResults[qi + i];
      if (r.status === 'fulfilled') {
        for (const u of r.value) {
          if (!seen.has(u)) {
            seen.add(u);
            urls.push(u);
          }
        }
      }
    }
    qi += p.queries.length;
    if (urls.length > 0) platformUrls[p.name] = urls;
  }

  const socials: SocialsResult = {};
  for (const [name, urls] of Object.entries(platformUrls)) {
    if (urls && urls.length > 0) {
      socials[name as keyof SocialsResult] = urls[0];
    }
  }

  console.log(
    `[person-article-search] searchBravePersonSocials: fandt ${Object.keys(socials).length} platforme (navnevariant: "${personName}"${hasMiddleName ? ` + "${short}"` : ''})`
  );
  return { socials, allCandidates: platformUrls as Record<string, string[]> };
}

/**
 * Søger kontaktoplysninger for en person via Brave Search.
 * Bruger kontakt-specifikke queries inkl. krak.dk, 118.dk og degulesider.dk.
 * Domæne-ekskludering springes over, da disse sider er relevante for kontaktdata.
 *
 * @param key        - Brave Search Subscription Token
 * @param personName - Personens fulde navn
 * @param city       - By (valgfrit, til geografisk præcisering)
 * @param companies  - Virksomheder personen er tilknyttet (bruges til kryds-søgning)
 */
async function searchBravePersonContacts(
  key: string,
  personName: string,
  city?: string,
  companies?: Array<{ cvr: number | string; name: string }>
): Promise<ArticleResult[]> {
  const queries: string[] = [
    `"${personName}" adresse telefon`,
    `"${personName}" kontakt email`,
    `"${personName}" site:krak.dk`,
    `"${personName}" site:118.dk`,
    `"${personName}" site:degulesider.dk`,
  ];

  // Geografi-baseret søgning øger præcision for almindelige navne
  if (city) {
    queries.push(`"${personName}" ${city} adresse`);
  }

  // Kryds-søgning: person + virksomhedsnavn (forbinder person med registrerede kontaktdata)
  if (companies && companies.length > 0) {
    for (const c of companies.slice(0, 3)) {
      queries.push(`"${personName}" "${c.name}"`);
    }
  }

  const results = await Promise.allSettled(queries.map((q) => searchBrave(key, q, 5, true)));

  const all: ArticleResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const item of r.value) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          all.push(item);
        }
      }
    }
  }

  console.log(
    `[person-article-search] searchBravePersonContacts: ${all.length} kontakt-resultater for "${personName}"`
  );
  return all;
}

/**
 * Sekundær telefonnummer-søgning — kører KUN hvis primær kontakt-søgning fandt adresse
 * men IKKE telefonnummer. Søger på krak.dk, 118.dk og virksomhedernes kontaktoplysninger.
 *
 * @param key        - Brave Search Subscription Token
 * @param personName - Personens fulde navn
 * @param city       - By (til disambiguation)
 * @param companies  - Virksomheder personen er tilknyttet (max 3 bruges)
 */
async function searchBravePersonPhone(
  key: string,
  personName: string,
  city: string | undefined,
  companies: Array<{ cvr: number | string; name: string }>
): Promise<ArticleResult[]> {
  const queries: string[] = [
    city ? `"${personName}" telefon ${city}` : `"${personName}" telefon`,
    `"${personName}" site:krak.dk`,
    `"${personName}" site:118.dk`,
  ];

  // Søg virksomhedernes kontaktoplysninger for eventuelle telefonnumre
  for (const c of companies.slice(0, 3)) {
    queries.push(`"${c.name}" kontakt telefon`);
  }

  const results = await Promise.allSettled(queries.map((q) => searchBrave(key, q, 5, true)));

  const all: ArticleResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const item of r.value) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          all.push(item);
        }
      }
    }
  }

  console.log(
    `[person-article-search] searchBravePersonPhone: ${all.length} ekstra telefon-resultater for "${personName}"`
  );
  return all;
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

EKSKLUDEREDE DOMÆNER — inkludér ALDRIG artikler fra disse domæner (konkurrenter):
ownr.dk, estatistik.dk, profiler.dk, krak.dk, proff.dk, paqle.dk, erhvervplus.dk, lasso.dk, cvrapi.dk, find-virksomhed.dk, virksomhedskartoteket.dk, crunchbase.com, b2bhint.com, resights.dk

RELEVANCEREGLER — afvis et resultat hvis:
- Det handler om en ANDEN person med samme navn
- Det er et jobopslag for en stilling personen ikke har nævneværdig tilknytning til
- Det er en generisk telefonbog/adressebog-side uden reel information
- Det er åbenlyst spam eller irrelevant indhold
- Det stammer fra et af de ekskluderede domæner ovenfor

CONFIDENCE-REGLER for sociale medier (PERSON-specifik):
- 90-100: Meget sikker — LinkedIn /in/ profil med personens fulde navn eksakt, billede matcher mv.
- 75-89: Ret sikker — stærkt navnematch og korrekt by/virksomhedskontext
- 60-74: Usikkert — delvist match, muligvis en anden med samme navn
- Under 60: Meget usikkert — kun et gæt
- Returner KUN LinkedIn-profiler med /in/ (ikke /company/) — disse er personlige profiler
- Gæt IKKE URLs — returner kun links du kender med rimelig sikkerhed (confidence >= 50)
- Returner ALDRIG generiske roddomæner (f.eks. "https://facebook.com/") — kun specifikke profil-URLs${learningContext}

KONTAKTOPLYSNINGER — ud over artikler og sociale medier, udtrék også kontaktoplysninger fra kontakt-søgeresultaterne (se separat sektion i brugerbesked):
- For hvert kontaktresultat der matcher personen: udtrék adresse, telefon og/eller email
- Angiv kilde-URL og kilde-navn (f.eks. "krak.dk")
- Giv en confidence score (0-100) baseret på navnematch og kontekst
- Inkludér en kort begrundelse

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
  },
  "contacts": [
    {
      "address": "Strandboulevarderden 108, 2650 Hvidovre",
      "phone": "+45 12 34 56 78",
      "email": "vicki@example.dk",
      "source": "krak.dk",
      "sourceUrl": "https://krak.dk/...",
      "confidence": 85,
      "reason": "Navn og by matcher CVR-registreret adresse"
    }
  ]
}

Regler for "socials":
- Udelad platforme du ikke kender (udelad feltet helt — returner ikke null eller tomt objekt)
- Returner altid "socials"-objektet (evt. tomt {})
- "alternatives"-arrayet kan være tomt [] men skal altid inkluderes for platforme du returnerer
- Ret IKKE URLs fra Brave — brug præcis de URLs fra Brave-resultaterne til artikler
- Opfind IKKE nye artikel-URLs — brug KUN de givne Brave-resultater

Regler for "contacts":
- Returner altid "contacts"-arrayet (evt. tomt [])
- Inkludér KUN kontaktresultater der specifikt handler om denne person
- address, phone og email er alle valgfrie — inkludér kun hvad der er tilgængeligt
- source skal være domænenavnet (f.eks. "krak.dk", "118.dk")
- sourceUrl skal være den præcise URL fra Brave-resultatet
- Opfind IKKE kontaktoplysninger — brug kun hvad Brave har returneret`;
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
 * Parser Claude's JSON-svar med artikelliste og sociale medier inkl. confidence-scores.
 * Filtrerer artikler der matcher sociale medie-URLs (samme base-domæne).
 *
 * @param text       - Rå tekstsvar fra Claude
 * @param threshold  - Confidence-tærskel: primære links under denne score flyttes til alternativer
 * @returns Parsede artikler, socials, socialAlternatives, socialsWithMeta, alternativesWithMeta, contacts
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
  contacts: ContactResult[];
} {
  const empty = {
    articles: [],
    socials: {},
    socialAlternatives: {},
    socialsWithMeta: {},
    alternativesWithMeta: {},
    contacts: [],
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

    // ── Kontaktoplysninger ──
    const rawContacts: unknown[] = Array.isArray(raw.contacts) ? raw.contacts : [];
    const contacts: ContactResult[] = rawContacts
      .filter(
        (c): c is Record<string, unknown> =>
          typeof c === 'object' &&
          c !== null &&
          typeof (c as Record<string, unknown>).sourceUrl === 'string'
      )
      .map((c) => ({
        address: typeof c.address === 'string' ? c.address.trim() : undefined,
        phone: typeof c.phone === 'string' ? c.phone.trim() : undefined,
        email: typeof c.email === 'string' ? c.email.trim() : undefined,
        source: typeof c.source === 'string' ? c.source.trim() : 'Ukendt kilde',
        sourceUrl: String(c.sourceUrl).trim(),
        confidence:
          typeof c.confidence === 'number'
            ? Math.max(0, Math.min(100, Math.round(c.confidence)))
            : 50,
        reason: typeof c.reason === 'string' ? c.reason.trim() : undefined,
      }))
      .filter((c) => isValidUrl(c.sourceUrl) && (c.address || c.phone || c.email));

    // ── Filtrer artikler der matcher sociale medie-domæner ──
    const socialUrls = Object.values(socials).filter(Boolean) as string[];
    const filteredArticles = articles.filter((a) => {
      if (!isSocialDomain(a.url)) return true;
      // Behold kun social-medie-artikler hvis de IKKE matcher et fundet socialt profil-domæne
      return !socialUrls.some((su) => isSameBaseDomain(a.url, su));
    });

    return {
      articles: filteredArticles,
      socials,
      socialAlternatives,
      socialsWithMeta,
      alternativesWithMeta,
      contacts,
    };
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

  console.log('[person-article-search] Companies modtaget:', JSON.stringify(companies));

  // ── Hent threshold + lærings-kontekst + Brave-data parallelt ────────────
  let braveResults: ArticleResult[];
  let braveSocials: SocialsResult;
  let braveSocialCandidates: Record<string, string[]>;
  let braveContactResults: ArticleResult[];
  let confidenceThreshold: number;
  let learningContext: string;

  try {
    const [articles, socialsResult, contactResults, threshold, learning] = await Promise.all([
      searchBravePersonArticles(braveKey, personName, companies),
      searchBravePersonSocials(braveKey, personName),
      searchBravePersonContacts(braveKey, personName, city, companies),
      fetchConfidenceThreshold(),
      buildLearningContext(),
    ]);
    braveResults = articles;
    braveSocials = socialsResult.socials;
    braveSocialCandidates = socialsResult.allCandidates;
    braveContactResults = contactResults;
    confidenceThreshold = threshold;
    learningContext = learning;
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
  if (Object.keys(braveSocialCandidates).length > 0) {
    const locationHint = city ? ` i ${city}` : ' i Danmark';
    // Vis alle kandidat-URLs per platform (inkl. fund fra kortere navnevariant)
    const candidatesStr = Object.entries(braveSocialCandidates)
      .map(([platform, urls]) => {
        if (urls.length === 1) return `- ${platform}: ${urls[0]}`;
        return `- ${platform}:\n${urls.map((u, i) => `    ${i + 1}. ${u}`).join('\n')}`;
      })
      .join('\n');
    socialVerificationSection =
      `\n\nBrave Search har fundet disse sociale medie-profil-kandidater — verificer om de tilhører NETOP DENNE PERSON${locationHint}:\n${candidatesStr}\n` +
      `Vælg den bedste URL per platform og brug den i din socials-output med passende confidence-score. ` +
      `Hvis ingen URL tilhører denne person, udelad platformen. Returner gerne alle kandidater som alternativer.`;
  }

  // ── Kontakt-søgeresultater ────────────────────────────────────────────────
  const contactSummary =
    braveContactResults.length > 0
      ? braveContactResults
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.description ? `\n   Snippet: ${r.description}` : ''}`
          )
          .join('\n\n')
      : '(Ingen kontakt-resultater fundet)';

  const contactSection = `\n\nKontakt-søgeresultater (${braveContactResults.length} hits — bruges til "contacts"-feltet i JSON):\n\n${contactSummary}`;

  const userMessage =
    `Person:\n${personContext}\n\nBrave Search-resultater (${braveResults.length} hits):\n\n${braveSummary}\n\nRangér og filtrer disse resultater. Find også personens sociale medier-links med confidence-scores.` +
    socialVerificationSection +
    contactSection;

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
    let totalTokens = totalInputTokens + totalOutputTokens;

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
      contacts,
    } = parsePersonArticleResponse(finalText, confidenceThreshold);

    // Claude's kvalitetssikrede links overskriver Brave-fund
    const socials: SocialsResult = { ...braveSocials, ...claudeSocials };

    // Fallback: Brave-fundne links for platforme Claude ikke verificerede med tilstrækkelig confidence.
    // Ensures at Brave-fund altid vises i frontend (socialsWithMeta), selv hvis Claude springer over.
    for (const [platform, url] of Object.entries(braveSocials)) {
      if (url && !socialsWithMeta[platform]) {
        socialsWithMeta[platform] = {
          url,
          confidence: 65,
          reason: 'Fundet via Brave Search (ikke verificeret af AI)',
        };
        console.log(
          `[person-article-search] Brave fallback socialsWithMeta: ${platform}=${url} (Claude verificerede ikke platformen)`
        );
      }
    }

    console.log(
      `[person-article-search] "${personName}": ${articles.length} artikler, tokens=${totalTokens}, ` +
        `brave-socials=[${Object.keys(braveSocials).join(',')}], ` +
        `primære links=[${Object.keys(socialsWithMeta).join(',')}], ` +
        `alternativer=[${Object.keys(alternativesWithMeta).join(',')}], ` +
        `kontakter=${contacts.length}, threshold=${confidenceThreshold}`
    );

    if (articles.length === 0) {
      console.warn(
        '[person-article-search] Ingen artikler parsede. Råsvar:',
        finalText.slice(0, 500)
      );
    }

    // ── Sekundær telefon-søgning hvis adresse fundet men ikke telefon ─────────
    const hasPhone = contacts.some((c) => c.phone);
    const hasAddress = contacts.some((c) => c.address);

    if (!hasPhone && hasAddress) {
      try {
        const extraContactResults = await searchBravePersonPhone(
          braveKey,
          personName,
          city,
          companies
        );

        if (extraContactResults.length > 0) {
          const existingAddress = contacts.find((c) => c.address)?.address ?? '';
          const extraSummary = extraContactResults
            .map(
              (r, i) =>
                `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.description ? `\n   Snippet: ${r.description}` : ''}`
            )
            .join('\n\n');

          const phoneResponse = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages: [
              {
                role: 'user',
                content:
                  `Find telefonnummer og email for ${personName}${existingAddress ? ` (bor på: ${existingAddress})` : ''} baseret på disse søgeresultater.\n\n` +
                  `${extraSummary}\n\n` +
                  `Returner KUN JSON:\n{"phone": "...", "email": "...", "source": "...", "sourceUrl": "...", "confidence": 70}\n` +
                  `Brug null for felter der ikke kan bekræftes. Returnér {} hvis ingen information.`,
              },
            ],
          });

          totalTokens +=
            (phoneResponse.usage?.input_tokens ?? 0) + (phoneResponse.usage?.output_tokens ?? 0);

          const extraText = phoneResponse.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');

          try {
            const jsonMatch =
              extraText.match(/```json\s*([\s\S]*?)\s*```/) ?? extraText.match(/(\{[\s\S]*\})/);
            if (jsonMatch) {
              const extraData = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as Record<string, unknown>;
              if (extraData.phone || extraData.email) {
                const addrContact = contacts.find((c) => c.address);
                if (addrContact) {
                  if (typeof extraData.phone === 'string') addrContact.phone = extraData.phone;
                  if (typeof extraData.email === 'string') addrContact.email = extraData.email;
                } else {
                  contacts.push({
                    phone: typeof extraData.phone === 'string' ? extraData.phone : undefined,
                    email: typeof extraData.email === 'string' ? extraData.email : undefined,
                    source:
                      typeof extraData.source === 'string' ? extraData.source : 'Sekundær søgning',
                    sourceUrl: typeof extraData.sourceUrl === 'string' ? extraData.sourceUrl : '',
                    confidence:
                      typeof extraData.confidence === 'number' ? extraData.confidence : 60,
                  });
                }
                console.log(
                  `[person-article-search] Sekundær telefon-søgning fandt: phone=${extraData.phone ?? '–'}, email=${extraData.email ?? '–'}`
                );
              }
            }
          } catch {
            // Ignorer parse-fejl fra sekundær søgning
          }
        }
      } catch (err) {
        console.warn(
          '[person-article-search] Sekundær telefon-søgning fejlede (ikke kritisk):',
          err instanceof Error ? err.message : err
        );
      }
    }

    const result: ArticleSearchResponse = {
      articles,
      socials,
      socialAlternatives,
      socialsWithMeta,
      alternativesWithMeta,
      contacts,
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
