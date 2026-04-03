/**
 * POST /api/ai/article-search
 *
 * AI-drevet artikelsøgning for danske virksomheder.
 *
 * Strategi:
 * 1. Brave Search API — henter op til 20 reelle artikler
 * 2. Claude — ranker, filtrerer og tilføjer beskrivelser til Brave-resultater
 *             + finder sociale medier-links
 * Ingen Claude-only fallback: mangler BRAVE_SEARCH_API_KEY → HTTP 500.
 *
 * Env vars:
 * - BRAVE_SEARCH_API_KEY    — Brave Search Subscription Token
 * - BIZZASSIST_CLAUDE_KEY   — Anthropic API-nøgle
 *
 * @param body.companyName  - Virksomhedens navn
 * @param body.cvr          - CVR-nummer (valgfrit)
 * @param body.industry     - Branchebeskrivelse (valgfrit)
 * @param body.employees    - Antal ansatte (valgfrit)
 * @param body.city         - By (valgfrit)
 * @param body.keyPersons   - Nøglepersoner: direktører, bestyrelsesmedlemmer (valgfrit)
 * @returns { articles, socials, socialAlternatives, tokensUsed, usage, source }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { rateLimit, AI_CHAT_LIMIT } from '@/app/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ───────────────────────────────────────────────────────────────────

/** En nyhedsartikel */
interface ArticleResult {
  /** Artiklens titel */
  title: string;
  /** URL til artiklen */
  url: string;
  /** Kildens navn (f.eks. "Børsen") */
  source: string;
  /** Dato som tekst */
  date?: string;
  /** Kort beskrivelse */
  description?: string;
}

/** Sociale medier og hjemmeside-links — primære URLs */
interface SocialsResult {
  website?: string;
  facebook?: string;
  linkedin?: string;
  instagram?: string;
  twitter?: string;
  youtube?: string;
}

/** Alternative links per platform */
type SocialAlternativesResult = Record<string, string[]>;

/** Svar-format fra API'en */
interface ArticleSearchResponse {
  articles: ArticleResult[];
  socials: SocialsResult;
  /** Alternative links per platform — op til 5 per platform */
  socialAlternatives: SocialAlternativesResult;
  tokensUsed: number;
  usage: { totalTokens: number };
  /** Angiver hvilken søgestrategi der blev brugt */
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

// ─── Brave Search ─────────────────────────────────────────────────────────────

/**
 * Søger via Brave Search API og returnerer rå artikelresultater.
 * Kaster fejl ved HTTP-fejl eller netværksproblemer — ingen stille fallback.
 *
 * @param key   - Brave Search Subscription Token
 * @param query - Søgeforespørgsel (typisk virksomhedsnavn + kontekst)
 * @param count - Antal resultater (max 20 pr. kald)
 * @returns Op til `count` Brave Search-resultater som ArticleResult[]
 * @throws Error ved HTTP-fejl eller netværksproblemer
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

  if (rawResults.length === 0) {
    return [];
  }

  // Dedupliker på URL
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
 * Søger artikler om en virksomhed via to parallelle Brave-queries:
 * 1. Generel nyheds-query (virksomhedsnavn + "nyheder artikel")
 * 2. Medie-specifik query med site:-filtre til danske nyhedsmedier
 *
 * Resultater merges og dedupliceres på URL — danske medier prioriteres.
 *
 * @param key         - Brave Search Subscription Token
 * @param companyName - Virksomhedens navn
 * @returns Merged og dedupliceret liste med op til 20 artikelresultater
 */
async function searchBraveArticles(key: string, companyName: string): Promise<ArticleResult[]> {
  // Primær: generel nyhedssøgning
  const query1 = `${companyName} nyheder artikel`;
  // Sekundær: medie-specifik søgning til danske nyhedsmedier
  const query2 = `${companyName} site:dr.dk OR site:tv2.dk OR site:borsen.dk OR site:berlingske.dk OR site:politiken.dk`;

  const [results1, results2] = await Promise.all([
    searchBrave(key, query1, 20),
    searchBrave(key, query2, 20),
  ]);

  // Merge med danske medier først — deduplication på URL
  const seen = new Set<string>();
  const merged: ArticleResult[] = [];
  for (const r of [...results2, ...results1]) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      merged.push(r);
    }
  }

  console.log(
    `[article-search] searchBraveArticles: query1=${results1.length} + query2=${results2.length} → merged=${merged.length}`
  );
  return merged;
}

/**
 * Søger sociale medier-profiler for en virksomhed via Brave Search API.
 * Én søgning per platform (6 total) køres parallelt for minimal latency.
 * Individuelle platform-fejl ignoreres stille — returnerer hvad der lykkes.
 *
 * @param key         - Brave Search Subscription Token
 * @param companyName - Virksomhedens navn
 * @returns Map af platform → verificeret URL (kun hvis fundet)
 */
async function searchBraveSocials(key: string, companyName: string): Promise<SocialsResult> {
  // Kendte katalog- og aggregatordomæner der aldrig er officielle hjemmesider
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
    // count=3 for website so we can skip directory hits
    { name: 'website', query: `${companyName} officiel hjemmeside`, count: 3 },
    { name: 'facebook', query: `${companyName} site:facebook.com`, count: 1 },
    { name: 'instagram', query: `${companyName} site:instagram.com`, count: 1 },
    { name: 'linkedin', query: `${companyName} site:linkedin.com`, count: 1 },
    { name: 'twitter', query: `${companyName} site:x.com OR site:twitter.com`, count: 1 },
    { name: 'youtube', query: `${companyName} site:youtube.com`, count: 1 },
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

      if (p.name === 'website') {
        // For hjemmeside: spring katalog-sites over og brug første rigtige domæne
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

  console.log(
    `[article-search] searchBraveSocials: fandt ${Object.keys(socials).length} platforme`
  );
  return socials;
}

// ─── System prompts ──────────────────────────────────────────────────────────

/**
 * System prompt til Brave+Claude-tilstand.
 * Claude modtager ALLE Brave-resultater (ufiltrerede) og kvalitetsvurderer dem:
 * 1. Vurderer om hvert hit er relevant for den specifikke virksomhed
 * 2. Prioriterer danske artikler, men inkluderer internationale hvis relevante
 * 3. Afviser artikler om en ANDEN virksomhed med lignende navn
 * 4. Afviser spam/generisk indhold
 * 5. Returnerer op til 15 kvalitetsvurderede artikler
 */
const SYSTEM_PROMPT_WITH_BRAVE = `Du er en dansk medieekspert. Du modtager ALLE Brave Search-resultater om en virksomhed — ufiltrerede.

Din opgave er at kvalitetsvurdere hvert eneste resultat og returnere de bedste:
1. Vurdér om hvert hit handler om DENNE SPECIFIKKE virksomhed (ikke en anden med lignende navn)
2. Prioritér danske artikler, men inkludér internationale hvis de handler om virksomheden
3. Sortér med nyeste/vigtigste først
4. Forbedre snippet-beskrivelser til max 100 tegn dansk tekst hvis nødvendigt
5. Find virksomhedens sociale medier og hjemmeside-links baseret på din viden

RELEVANCEREGLER — afvis et resultat hvis:
- Det handler om en ANDEN virksomhed med samme eller lignende navn
- Det er et jobopslag (stillingsopslag, karriere, ledige stillinger)
- Det er en generisk brancheportal eller aggregator der bare lister virksomheden
- Det er åbenlyst spam eller irrelevant indhold (SEO-spam, scraper-sites)
- Det er en tom/generisk virksomhedsprofilside uden reel information

INKLUDÉR disse typer (hvis relevante for virksomheden):
- Nyhedsartikler fra alle medier — både danske og internationale
- Pressemeddelelser og erhvervsmeddelelser
- Branchemedier og faglige publikationer
- Anmeldelser og omtaler (TripAdvisor, Google, etc.) hvis virksomheden er forbrugervendt
- Blogindlæg og sociale medier-opslag hvis de er informative

KRITISKE REGLER:
- Ret IKKE URLs — brug præcis de URLs fra Brave-resultaterne
- Opfind IKKE nye artikler — brug KUN de givne resultater
- Returner max 15, men gerne færre hvis kun 3-4 er reelt relevante

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
      "primary": "https://virksomhed.dk",
      "alternatives": ["https://www.virksomhed.dk"]
    },
    "linkedin": {
      "primary": "https://www.linkedin.com/company/slug",
      "alternatives": []
    },
    "facebook": {
      "primary": "https://www.facebook.com/slug",
      "alternatives": []
    },
    "instagram": {
      "primary": "https://www.instagram.com/slug",
      "alternatives": []
    },
    "twitter": {
      "primary": "https://x.com/slug",
      "alternatives": []
    },
    "youtube": {
      "primary": "https://www.youtube.com/@slug",
      "alternatives": []
    }
  }
}

Regler for "socials":
- Gæt IKKE URLs — skriv kun præcise links du kender med sikkerhed
- Returner ALDRIG generiske roddomæner som "https://facebook.com" — kun specifikke profil-URLs
- Udelad felter du ikke kender med sikkerhed
- Returner altid "socials"-objektet (evt. tomt {})`;

// ─── Response parser ─────────────────────────────────────────────────────────

/**
 * Returnerer true hvis to URLs tilhører samme base-domæne.
 * Ignorerer www.-præfiks og TLD-varianter (.dk/.com/.org/.net/.io).
 * Bruges til at filtrere alternative links der er reelt identiske med primær-URL.
 *
 * @param url1 - Primær URL
 * @param url2 - Alternativ URL der sammenlignes
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
 * Parser Claude's JSON-svar med artikelliste og sociale medier.
 * Understøtter både gammel format (string) og nyt format ({ primary, alternatives }).
 *
 * @param text - Rå tekstsvar fra Claude (JSON med articles[] og socials{})
 * @returns Parsede artikler, primære sociale medier-links og alternativer per platform
 */
function parseArticleResponse(text: string): {
  articles: ArticleResult[];
  socials: SocialsResult;
  socialAlternatives: SocialAlternativesResult;
} {
  const empty = { articles: [], socials: {}, socialAlternatives: {} };
  try {
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ??
      text.match(/```\s*([\s\S]*?)\s*```/) ??
      text.match(/(\{[\s\S]*\})/);

    if (!jsonMatch) return empty;

    const raw = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);

    // Parse artikler fra JSON-arrayet
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
        // Afvis kun resultater med ugyldig URL-format — al indholdsmæssig filtrering
        // er delegeret til Claude, som vurderer relevans for den specifikke virksomhed.
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

    // Udtræk sociale medier — understøtter både gammel (string) og nyt ({ primary, alternatives }) format
    const rawSocials = raw.socials ?? {};
    const socials: SocialsResult = {};
    const socialAlternatives: SocialAlternativesResult = {};
    const socialKeys: (keyof SocialsResult)[] = [
      'website',
      'facebook',
      'linkedin',
      'instagram',
      'twitter',
      'youtube',
    ];

    /**
     * Returnerer true hvis URL har et gyldigt format.
     *
     * @param url - URL der skal valideres
     */
    const isValidUrl = (url: string): boolean => {
      try {
        new URL(url);
        return url.startsWith('https://') || url.startsWith('http://');
      } catch {
        return false;
      }
    };

    for (const key of socialKeys) {
      const val = rawSocials[key];
      if (!val) continue;

      if (typeof val === 'string' && isValidUrl(val)) {
        // Gammel format: direkte URL-streng
        socials[key] = val.trim();
      } else if (typeof val === 'object' && val !== null) {
        // Nyt format: { primary, alternatives }
        const entry = val as Record<string, unknown>;
        if (typeof entry.primary === 'string' && isValidUrl(entry.primary)) {
          socials[key] = entry.primary.trim();
        }
        if (Array.isArray(entry.alternatives)) {
          const primaryUrl = socials[key];
          const alts = (entry.alternatives as unknown[])
            .filter((a): a is string => typeof a === 'string' && isValidUrl(a))
            .map((a) => a.trim())
            // Fjern alternativer der er identiske med eller samme base-domæne som primær
            .filter((a) => !primaryUrl || (a !== primaryUrl && !isSameBaseDomain(a, primaryUrl)))
            .slice(0, 5);
          if (alts.length > 0) {
            socialAlternatives[key] = alts;
          }
        }
      }
    }

    return { articles, socials, socialAlternatives };
  } catch {
    return empty;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/article-search
 *
 * Søger efter artikler og sociale medier om en virksomhed.
 * Brave Search API henter rå resultater — Claude rangerer og filtrerer.
 * Ingen Claude-only fallback: hvis Brave fejler, returneres en fejlbesked.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Rate limit — deler grænse med AI chat
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

  // Byg virksomhedskontekst til Claude
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

  const client = new Anthropic({ apiKey });

  // ── Kør Brave-søgning og social profile-søgning parallelt ────────────────
  let braveResults: ArticleResult[];
  let braveSocials: SocialsResult;
  try {
    [braveResults, braveSocials] = await Promise.all([
      searchBraveArticles(braveKey, companyName),
      searchBraveSocials(braveKey, companyName),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt Brave Search fejl';
    console.error('[article-search] Brave Search fejlede:', msg);
    return NextResponse.json({ error: `Brave Search fejlede: ${msg}` }, { status: 502 });
  }

  console.log(
    `[article-search] "${companyName}": Brave Search ${braveResults.length} rå resultater (dual-query)`
  );

  // ── Byg Claude-besked ────────────────────────────────────────────────────
  const braveSummary =
    braveResults.length > 0
      ? braveResults
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.date ? `\n   Dato: ${r.date}` : ''}${r.description ? `\n   Snippet: ${r.description}` : ''}`
          )
          .join('\n\n')
      : '(Ingen Brave-resultater for denne søgning)';

  // Byg social verification-sektion: Brave-fund sendes til Claude til kvalificering
  let socialVerificationSection = '';
  if (Object.keys(braveSocials).length > 0) {
    const socialsStr = Object.entries(braveSocials)
      .map(([platform, url]) => `- ${platform}: ${url}`)
      .join('\n');
    const locationHint = city ? ` i ${city}` : ' i Danmark';
    socialVerificationSection =
      `\n\nBrave Search har fundet disse sociale medie-profiler — verificer om de tilhører NETOP DENNE virksomhed${locationHint}:\n${socialsStr}\n` +
      `Brug dem i din socials-output hvis de er korrekte for denne specifikke virksomhed. Hvis en profil tilhører en anden virksomhed, udelad den og brug din egen viden i stedet.`;
  }

  const userMessage =
    `Virksomhed:\n${companyContext}\n\nBrave Search-resultater (${braveResults.length} hits):\n\n${braveSummary}\n\nRangér og filtrer disse resultater. Find også sociale medier-links.` +
    socialVerificationSection;
  const systemPrompt = SYSTEM_PROMPT_WITH_BRAVE;

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

    // Udtræk tekstsvar
    const finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const {
      articles,
      socials: claudeSocials,
      socialAlternatives,
    } = parseArticleResponse(finalText);

    // Claude overskriver Brave-socials hvis Claude har verificeret dem (kvalitetssikring).
    // Brave-fund bruges som supplement for platforme Claude ikke inkluderede.
    const socials: SocialsResult = { ...braveSocials, ...claudeSocials };

    console.log(
      `[article-search] "${companyName}": Brave=${braveResults.length} rå → Claude valgte ${articles.length} artikler, tokens=${totalTokens}, socials=[brave:${Object.keys(braveSocials).join(',')}, claude:${Object.keys(claudeSocials).join(',')}]`
    );

    if (articles.length === 0) {
      console.warn('[article-search] Ingen artikler parsede. Råsvar:', finalText.slice(0, 500));
    }

    const result: ArticleSearchResponse = {
      articles,
      socials,
      socialAlternatives,
      tokensUsed: totalTokens,
      usage: { totalTokens },
      source: 'brave+claude',
    };

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error('[article-search] Fejl:', err);

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
