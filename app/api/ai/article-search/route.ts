/**
 * POST /api/ai/article-search
 *
 * AI-drevet artikelsøgning for danske virksomheder.
 *
 * Strategi:
 * 1. Primær: Brave Search API — henter op til 20 reelle artikler
 * 2. Claude: ranker, filtrerer og tilføjer beskrivelser til Brave-resultater
 *            + finder sociale medier-links
 * 3. Fallback: Claude-only (hvis BRAVE_SEARCH_API_KEY ikke er sat)
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
  source: 'brave+claude' | 'claude-only';
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
 * Returnerer tomt array hvis credentials mangler eller et netværksfejl opstår.
 *
 * @param query - Søgeforespørgsel (typisk virksomhedsnavn + kontekst)
 * @param count - Antal resultater (max 20 pr. kald)
 * @returns Op til `count` Brave Search-resultater som ArticleResult[]
 */
async function searchBrave(query: string, count = 20): Promise<ArticleResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!key) return [];

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&country=dk&search_lang=da&ui_lang=da`;
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    });

    if (!res.ok) {
      console.warn(`[article-search] Brave Search HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const rawResults: BraveWebResult[] = data.web?.results ?? [];

    if (rawResults.length === 0) {
      console.log('[article-search] Brave Search: 0 resultater returneret');
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
  } catch (err) {
    console.warn('[article-search] Brave Search fejl:', err);
    return [];
  }
}

/**
 * Søger sociale medier-profiler for en virksomhed via Brave Search API.
 * Én søgning per platform (6 total) køres parallelt for minimal latency.
 * Returnerer tomt objekt hvis BRAVE_SEARCH_API_KEY mangler.
 *
 * @param companyName - Virksomhedens navn
 * @returns Map af platform → verificeret URL (kun hvis fundet)
 */
async function searchBraveSocials(companyName: string): Promise<SocialsResult> {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!key) return {};

  const platforms: Array<{ name: keyof SocialsResult; query: string }> = [
    { name: 'website', query: `${companyName} officiel hjemmeside` },
    { name: 'facebook', query: `${companyName} site:facebook.com` },
    { name: 'instagram', query: `${companyName} site:instagram.com` },
    { name: 'linkedin', query: `${companyName} site:linkedin.com` },
    { name: 'twitter', query: `${companyName} site:x.com OR site:twitter.com` },
    { name: 'youtube', query: `${companyName} site:youtube.com` },
  ];

  const results = await Promise.allSettled(
    platforms.map(async (p) => {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(p.query)}&count=1&country=dk`;
      const res = await fetch(url, {
        headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      return { name: p.name, url: (data.web?.results?.[0]?.url as string) || null };
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

/**
 * System prompt til Claude-only fallback.
 * Claude genererer artikelliste + sociale medier udelukkende fra sin træningsviden.
 */
const SYSTEM_PROMPT_CLAUDE_ONLY = `Du er en dansk medieekspert med dybdegående kendskab til danske nyheder og medier.

Baseret på din træningsviden, find DANSKE artikler om den angivne virksomhed fra de seneste 2 år. Brug disse medier:
DR, TV2, Børsen, Berlingske, Politiken, Jyllands-Posten, Altinget, Information, FinansWatch, MedWatch, Ingeniøren, Version2, Computerworld, Weekendavisen, Zetland, BT, Ekstra Bladet, Frihedsbrevet, Danwatch, Mandag Morgen.

KRITISKE REGLER FOR ARTIKLER:
- Returner de artikler du FAKTISK kender med 100% sikkerhed — 0 er helt acceptabelt for ukendte lokale virksomheder
- Opfind ALDRIG artikler — brug KUN artikler du er sikker på eksisterer med korrekte URLs
- Max 15 artikler, spred over FLERE forskellige medier (ét medie max 3 artikler)
- Inkludér artikler fra de seneste 2 år (ikke kun seneste måned)
- INGEN engelske, norske eller svenske artikler — kun ovenstående danske medier
- INGEN artikler fra GlobeNewswire, Reuters, Bloomberg, AP — kun ovenstående danske medier
- Gæt IKKE URLs — skriv kun præcise links du kender med absolut sikkerhed
- Hvis du er i tvivl om en artikel eksisterer, udelad den

Returner KUN validt JSON uden tekst før/efter:

{
  "articles": [
    {
      "title": "Artiklens titel på dansk",
      "url": "https://borsen.dk/...",
      "source": "Børsen",
      "date": "15. jan. 2025",
      "description": "Max 80 tegn beskrivelse"
    }
  ],
  "socials": {
    "website": {
      "primary": "https://virksomhed.dk",
      "alternatives": ["https://www.virksomhed.dk", "https://virksomhed.com"]
    },
    "linkedin": {
      "primary": "https://www.linkedin.com/company/slug",
      "alternatives": ["https://www.linkedin.com/company/slug2", "https://www.linkedin.com/company/slug3"]
    },
    "facebook": {
      "primary": "https://www.facebook.com/slug",
      "alternatives": ["https://www.facebook.com/slug2"]
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
- Brug din træningsviden til at finde virksomhedens officielle links
- For store/kendte virksomheder forventes minimum website + linkedin
- Udelad KUN felter hvor du er helt sikker på at profilen ikke eksisterer
- Gæt IKKE URLs — skriv kun præcise links du kender med sikkerhed
- For hvert felt: angiv "primary" (det mest sandsynlige link) og op til 5 "alternatives" (andre mulige URLs)
- "alternatives" kan være tomt array [] hvis du kun kender ét link
- Returner altid "socials"-objektet (evt. tomt {})
- Returner ALDRIG generiske roddomæner som "https://facebook.com", "https://linkedin.com", "https://instagram.com" — kun specifikke profil-URLs med sti (f.eks. "/company/slug" eller "/virksomhed")
- Hvis du ikke kender den specifikke profil-URL for et felt, udelad feltet helt (sæt det til null eller udelad det fra JSON-objektet)
- Hvis du ikke finder nogen artikler om virksomheden, returner en tom articles array — returner ikke opfundne artikler`;

// ─── Response parser ─────────────────────────────────────────────────────────

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
          const alts = (entry.alternatives as unknown[])
            .filter((a): a is string => typeof a === 'string' && isValidUrl(a))
            .map((a) => a.trim())
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
 * Søger efter danske artikler om en virksomhed.
 * Primær: Brave Search API → Claude rangering.
 * Fallback: Claude-only (hvis BRAVE_SEARCH_API_KEY ikke er sat).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Rate limit — deler grænse med AI chat
  const limited = rateLimit(request, AI_CHAT_LIMIT);
  if (limited) return NextResponse.json({ error: 'Rate limit overskredet' }, { status: 429 });

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });
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
  const braveQuery = city
    ? `${companyName} ${city} nyhed`
    : `${companyName} dansk virksomhed nyhed`;

  const [braveResults, braveSocials] = await Promise.all([
    searchBrave(braveQuery),
    searchBraveSocials(companyName),
  ]);
  const useBrave = braveResults.length > 0;

  console.log(
    `[article-search] "${companyName}": ${useBrave ? `Brave Search ${braveResults.length} rå resultater` : 'Claude-only fallback'}`
  );

  // ── Byg Claude-besked ────────────────────────────────────────────────────
  let userMessage: string;
  let systemPrompt: string;

  if (useBrave) {
    // Brave+Claude tilstand: send Brave-resultater som kontekst
    const braveSummary = braveResults
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.date ? `\n   Dato: ${r.date}` : ''}${r.description ? `\n   Snippet: ${r.description}` : ''}`
      )
      .join('\n\n');

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

    userMessage =
      `Virksomhed:\n${companyContext}\n\nBrave Search-resultater (${braveResults.length} hits):\n\n${braveSummary}\n\nRangér og filtrer disse resultater. Find også sociale medier-links.` +
      socialVerificationSection;
    systemPrompt = SYSTEM_PROMPT_WITH_BRAVE;
  } else {
    // Claude-only fallback
    userMessage = `Find de seneste danske artikler om denne virksomhed og returner sociale medier-links:\n\n${companyContext}`;
    systemPrompt = SYSTEM_PROMPT_CLAUDE_ONLY;
  }

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

    // Merge-strategi:
    // - brave+claude tilstand: Claude har verificeret Brave-hits → stol på Claude's output.
    //   Brave bruges kun som supplement for platforme Claude ikke inkluderede.
    // - claude-only tilstand: Kun Claude's output.
    const socials: SocialsResult = useBrave
      ? { ...braveSocials, ...claudeSocials } // Claude overskriver Brave hvis Claude har verificeret
      : claudeSocials;

    console.log(
      `[article-search] "${companyName}": Brave=${braveResults.length} rå → Claude valgte ${articles.length} artikler, tokens=${totalTokens}, source=${useBrave ? 'brave+claude' : 'claude-only'}, socials=[brave:${Object.keys(braveSocials).join(',')}, claude:${Object.keys(claudeSocials).join(',')}]`
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
      source: useBrave ? 'brave+claude' : 'claude-only',
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
