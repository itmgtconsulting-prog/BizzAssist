/**
 * POST /api/ai/article-search
 *
 * AI-drevet artikelsøgning for danske virksomheder.
 *
 * Strategi:
 * 1. Primær: Google Custom Search API — henter op til 20 reelle artikler
 * 2. Claude: ranker, filtrerer og tilføjer beskrivelser til Google-resultater
 *            + finder sociale medier-links
 * 3. Fallback: Claude-only (hvis GOOGLE_CSE_API_KEY ikke er sat)
 *
 * Env vars:
 * - GOOGLE_CSE_API_KEY  — Google Cloud API-nøgle
 * - GOOGLE_CSE_ID       — Custom Search Engine ID (cx)
 * - BIZZASSIST_CLAUDE_KEY — Anthropic API-nøgle
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
  source: 'google+claude' | 'claude-only';
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

/** Et Google Custom Search resultat (råformat) */
interface GoogleSearchItem {
  title: string;
  link: string;
  displayLink: string;
  snippet?: string;
  pagemap?: {
    metatags?: Array<Record<string, string>>;
  };
}

// ─── Google Custom Search ────────────────────────────────────────────────────

/**
 * Søger via Google Custom Search API og returnerer rå artikelresultater.
 * Kalder API'en to gange (start=1 og start=11) for op til 20 resultater.
 * Returnerer tomt array hvis credentials mangler eller et netværksfejl opstår.
 *
 * @param query - Søgeforespørgsel (typisk virksomhedsnavn + kontekst)
 * @returns Op til 20 Google Search-resultater som ArticleResult[]
 */
async function searchGoogleCSE(query: string): Promise<ArticleResult[]> {
  const key = process.env.GOOGLE_CSE_API_KEY?.trim();
  const cx = process.env.GOOGLE_CSE_ID?.trim();

  // Fallback til Claude-only hvis credentials mangler
  if (!key || !cx) return [];

  const baseUrl = 'https://www.googleapis.com/customsearch/v1';
  const params = new URLSearchParams({
    key,
    cx,
    q: query,
    lr: 'lang_da',
    gl: 'dk',
    num: '10',
  });

  const results: ArticleResult[] = [];

  // Hent to sider (1-10 og 11-20) parallelt for hastighed
  const pageStarts = [1, 11];

  await Promise.allSettled(
    pageStarts.map(async (start) => {
      try {
        const url = `${baseUrl}?${params.toString()}&start=${start}`;
        const res = await fetch(url, { next: { revalidate: 0 } });

        if (!res.ok) {
          console.warn(`[article-search] Google CSE HTTP ${res.status} (start=${start})`);
          return;
        }

        const data = (await res.json()) as { items?: GoogleSearchItem[] };

        if (!Array.isArray(data.items)) {
          console.log(
            `[article-search] Google CSE start=${start}: ingen items i response. Response keys: ${Object.keys(data).join(', ')}`
          );
          return;
        }

        if (data.items.length === 0) {
          console.log(`[article-search] Google CSE start=${start}: 0 resultater returneret`);
          return;
        }

        for (const item of data.items) {
          // Udtræk publiceret-dato fra Open Graph metatags hvis tilgængeligt
          const publishedTime =
            item.pagemap?.metatags?.[0]?.['article:published_time'] ??
            item.pagemap?.metatags?.[0]?.['og:updated_time'] ??
            '';

          results.push({
            title: item.title?.trim() ?? '',
            url: item.link?.trim() ?? '',
            source: item.displayLink?.replace(/^www\./, '').trim() ?? '',
            description: item.snippet?.trim().slice(0, 150) ?? undefined,
            date: publishedTime ? formatGoogleDate(publishedTime) : undefined,
          });
        }
      } catch (err) {
        console.warn(`[article-search] Google CSE fejl (start=${start}):`, err);
      }
    })
  );

  // Fjern duplikater baseret på URL
  const seen = new Set<string>();
  return results.filter((r) => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Formaterer en ISO 8601-dato (f.eks. "2025-01-15T...") til dansk datoformat
 * (f.eks. "15. jan. 2025"). Returnerer tom streng ved fejl.
 *
 * @param isoDate - ISO 8601 datotekst
 * @returns Formateret dansk dato eller tom streng
 */
function formatGoogleDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('da-DK', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

// ─── Social Profile Search ────────────────────────────────────────────────────

/**
 * Søger sociale medier-profiler for en virksomhed via Google Custom Search API.
 * Én søgning per platform (6 total) køres parallelt for minimal latency.
 * Returnerer tomt objekt hvis GOOGLE_CSE_API_KEY eller GOOGLE_CSE_ID mangler.
 *
 * @param companyName - Virksomhedens navn
 * @returns Map af platform → verificeret URL (kun hvis fundet)
 */
async function searchSocialProfiles(companyName: string): Promise<SocialsResult> {
  const key = process.env.GOOGLE_CSE_API_KEY?.trim();
  const cx = process.env.GOOGLE_CSE_ID?.trim();
  if (!key || !cx) return {};

  // Website-søgning ekskluderer eksplicit alle sociale medier-domæner så vi ikke
  // ender med facebook.com/virksomhed som "hjemmeside".
  const websiteExclusions =
    '-site:facebook.com -site:instagram.com -site:linkedin.com -site:twitter.com -site:x.com -site:youtube.com';

  const platforms: Array<{
    name: keyof SocialsResult;
    query: string;
    domainHint: string;
    /** Sæt true for platforme hvor rod-URL (pathname="/") er en gyldig profil-URL */
    skipPathCheck?: boolean;
  }> = [
    { name: 'facebook', query: `${companyName} site:facebook.com`, domainHint: 'facebook.com' },
    { name: 'instagram', query: `${companyName} site:instagram.com`, domainHint: 'instagram.com' },
    {
      name: 'linkedin',
      query: `${companyName} site:linkedin.com/company`,
      domainHint: 'linkedin.com',
    },
    {
      name: 'twitter',
      query: `${companyName} site:twitter.com OR site:x.com`,
      domainHint: 'x.com',
    },
    { name: 'youtube', query: `${companyName} site:youtube.com`, domainHint: 'youtube.com' },
    {
      // Website: bred søgning der ekskluderer sociale medier.
      // skipPathCheck=true fordi novonordisk.com/ har pathname="/" — det er en gyldig hjemmeside.
      name: 'website',
      query: `${companyName} officiel hjemmeside ${websiteExclusions}`,
      domainHint: '',
      skipPathCheck: true,
    },
  ];

  const results = await Promise.allSettled(
    platforms.map(async (p) => {
      const url =
        `https://www.googleapis.com/customsearch/v1` +
        `?key=${encodeURIComponent(key)}` +
        `&cx=${encodeURIComponent(cx)}` +
        `&q=${encodeURIComponent(p.query)}` +
        `&num=1`;

      const res = await fetch(url, { signal: AbortSignal.timeout(5000), next: { revalidate: 0 } });
      const data = (await res.json()) as { items?: Array<{ link: string; displayLink: string }> };
      const item = data.items?.[0] ?? null;
      const link = item?.link ?? null;

      if (!link) return null;

      // Log website-resultat for debugging
      if (p.name === 'website') {
        console.log(`[article-search] website CSE hit: ${link}`);
      }

      // Afvis resultater der ikke matcher den forventede platform
      if (p.domainHint && !link.includes(p.domainHint)) return null;

      // Afvis generiske roddomæner (ingen specifik sti) — KUN for sociale medier.
      // For website er rod-URL (pathname="/") en gyldig virksomhedshjemmeside.
      if (!p.skipPathCheck) {
        try {
          const { pathname } = new URL(link);
          if (pathname === '/' || pathname === '') return null;
        } catch {
          return null;
        }
      }

      return { name: p.name, url: link };
    })
  );

  const socials: SocialsResult = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      socials[r.value.name] = r.value.url;
    }
  }

  console.log(
    `[article-search] searchSocialProfiles: fandt ${Object.keys(socials).length} platforme`
  );
  return socials;
}

// ─── System prompts ──────────────────────────────────────────────────────────

/**
 * System prompt til Google+Claude-tilstand.
 * Claude modtager Google-resultater som kontekst og skal:
 * 1. Rangere + filtrere dem til max 15 relevante artikler
 * 2. Forbedre beskrivelser hvis nødvendigt
 * 3. Finde sociale medier-links
 */
const SYSTEM_PROMPT_WITH_GOOGLE = `Du er en dansk medieekspert. Du modtager Google Search-resultater om en dansk virksomhed.

Din opgave:
1. Vælg de mest relevante og informative artikler — max 15, min 5
2. Sorter dem med nyeste/vigtigste først
3. Forbedre snippet-beskrivelser til max 100 tegn dansk tekst hvis nødvendigt
4. Find virksomhedens sociale medier og hjemmeside-links baseret på din viden

FILTRERINGSREGLER:
- Udelad ikke-relevante resultater (jobopslag, generiske branchesider, aggregator-spam)
- Bevar artikler fra kendte danske medier: DR, TV2, Børsen, Berlingske, Politiken, Jyllands-Posten, Altinget, Information, FinansWatch, MedWatch, Ingeniøren, Version2, Computerworld, Weekendavisen, Zetland, BT, Ekstra Bladet, Frihedsbrevet, Danwatch, Mandag Morgen
- Inkludér også pressemeddelelser og branchemedier hvis de er relevante
- Ret IKKE URLs — brug præcis de URLs fra Google-resultaterne
- Opfind IKKE nye artikler — brug KUN de givne resultater

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
- Returner PRÆCIS 15 artikler — ikke "op til 15", ikke 10, men nøjagtigt 15
- Spred artiklerne over FLERE forskellige medier — ét medie må max bidrage med 3 artikler
- Inkludér artikler fra de seneste 2 år (ikke kun seneste måned)
- Returner KUN artikler du er 100% SIKKER på eksisterer med korrekte URLs
- INGEN engelske, norske eller svenske artikler — kun ovenstående danske medier
- INGEN artikler fra GlobeNewswire, Reuters, Bloomberg, AP — kun ovenstående danske medier
- Gæt IKKE URLs — skriv kun præcise links du kender med absolut sikkerhed
- Hvis du mangler artikler for at nå 15, søg bredere: brug ældre artikler (op til 2 år tilbage), brug flere medier

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
        const url = String(a.url);
        // Afvis ikke-danske internationale medier
        const blocked = [
          'globenewswire',
          'reuters',
          'bloomberg',
          'apnews',
          'ap.org',
          'ft.com',
          '.no/',
          '.se/',
        ];
        return url.startsWith('https://') && !blocked.some((b) => url.includes(b));
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
     * Returnerer true hvis URL er et generisk roddomæne uden specifik sti
     * (f.eks. "https://facebook.com" eller "https://www.facebook.com/").
     * Generiske URLs fra Claude filtreres fra — de er ubrugelige for brugeren.
     *
     * @param url - URL der skal tjekkes
     */
    const isGenericUrl = (url: string): boolean => {
      try {
        const { pathname } = new URL(url);
        return pathname === '/' || pathname === '';
      } catch {
        return true; // Ugyldig URL — afvis
      }
    };

    for (const key of socialKeys) {
      const val = rawSocials[key];
      if (!val) continue;

      if (typeof val === 'string' && val.startsWith('https://') && !isGenericUrl(val)) {
        // Gammel format: direkte URL-streng
        socials[key] = val.trim();
      } else if (typeof val === 'object' && val !== null) {
        // Nyt format: { primary, alternatives }
        const entry = val as Record<string, unknown>;
        if (
          typeof entry.primary === 'string' &&
          entry.primary.startsWith('https://') &&
          !isGenericUrl(entry.primary)
        ) {
          socials[key] = entry.primary.trim();
        }
        if (Array.isArray(entry.alternatives)) {
          const alts = (entry.alternatives as unknown[])
            .filter(
              (a): a is string =>
                typeof a === 'string' && a.startsWith('https://') && !isGenericUrl(a)
            )
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
 * Primær: Google Custom Search API → Claude rangering.
 * Fallback: Claude-only (hvis GOOGLE_CSE_API_KEY ikke er sat).
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

  // ── Forsøg Google CSE + social profile-søgning parallelt ────────────────
  const googleQuery = city
    ? `${companyName} ${city} nyhed`
    : `${companyName} dansk virksomhed nyhed`;

  const [googleResults, googleSocials] = await Promise.all([
    searchGoogleCSE(googleQuery),
    searchSocialProfiles(companyName),
  ]);
  const useGoogle = googleResults.length > 0;

  console.log(
    `[article-search] "${companyName}": ${useGoogle ? `Google CSE ${googleResults.length} resultater` : 'Claude-only fallback'}`
  );

  // ── Byg Claude-besked ────────────────────────────────────────────────────
  let userMessage: string;
  let systemPrompt: string;

  if (useGoogle) {
    // Google+Claude tilstand: send Google-resultater som kontekst
    const googleSummary = googleResults
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.date ? `\n   Dato: ${r.date}` : ''}${r.description ? `\n   Snippet: ${r.description}` : ''}`
      )
      .join('\n\n');

    userMessage = `Virksomhed:\n${companyContext}\n\nGoogle Search-resultater (${googleResults.length} hits):\n\n${googleSummary}\n\nRangér og filtrer disse resultater. Find også sociale medier-links.`;
    systemPrompt = SYSTEM_PROMPT_WITH_GOOGLE;
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

    // Merge: Google CSE-fundne sociale medier har prioritet da de er verificerede links.
    // Claude's fund bruges som fallback for platforme Google ikke fandt.
    const socials: SocialsResult = { ...claudeSocials, ...googleSocials };

    console.log(
      `[article-search] "${companyName}": ${articles.length} artikler, tokens=${totalTokens}, source=${useGoogle ? 'google+claude' : 'claude-only'}, socials=[google:${Object.keys(googleSocials).join(',')}]`
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
      source: useGoogle ? 'google+claude' : 'claude-only',
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
