/**
 * POST /api/ai/article-search
 *
 * AI-drevet artikelsøgning for danske virksomheder.
 *
 * Strategi: Claude genererer artikelliste baseret på træningsviden.
 * Ingen RSS-feeds, ingen Google News — kun Claude med danske medier.
 *
 * @param body.companyName  - Virksomhedens navn
 * @param body.cvr          - CVR-nummer (valgfrit)
 * @param body.industry     - Branchebeskrivelse (valgfrit)
 * @param body.employees    - Antal ansatte (valgfrit)
 * @param body.city         - By (valgfrit)
 * @param body.keyPersons   - Nøglepersoner: direktører, bestyrelsesmedlemmer (valgfrit)
 * @returns { articles, socials, usage }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { rateLimit, AI_CHAT_LIMIT } from '@/app/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ──────────────────────────────────────────────────────────────────

/** En nyhedsartikel fundet af Claude */
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

/** Sociale medier og hjemmeside-links fundet af Claude — primære URLs */
interface SocialsResult {
  website?: string;
  facebook?: string;
  linkedin?: string;
  instagram?: string;
  twitter?: string;
  youtube?: string;
}

/** Alternative links per platform fundet af Claude */
type SocialAlternativesResult = Record<string, string[]>;

/** Svar-format fra API'en */
interface ArticleSearchResponse {
  articles: ArticleResult[];
  socials: SocialsResult;
  /** Alternative links per platform — op til 5 per platform */
  socialAlternatives: SocialAlternativesResult;
  tokensUsed: number;
  usage: { totalTokens: number };
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

// ─── System prompt ──────────────────────────────────────────────────────────

/**
 * System prompt der beder Claude om at generere danske artikler baseret på
 * sin træningsviden. Claude returnerer artikler direkte som JSON — ingen indeks.
 */
const SYSTEM_PROMPT = `Du er en dansk medieekspert med dybdegående kendskab til danske nyheder og medier.

Baseret på din træningsviden, find DANSKE artikler om den angivne virksomhed fra de seneste 2 år. Brug disse medier:
DR, TV2, Børsen, Berlingske, Politiken, Jyllands-Posten, Altinget, Information, FinansWatch, MedWatch, Ingeniøren, Version2, Computerworld, Weekendavisen, Zetland, BT, Ekstra Bladet, Frihedsbrevet, Danwatch, Mandag Morgen.

KRITISKE REGLER FOR ARTIKLER:
- Returner PRÆCIS 10 artikler — ikke "op til 10", ikke 4, men nøjagtigt 10
- Spred artiklerne over FLERE forskellige medier — ét medie må max bidrage med 3 artikler
- Inkludér artikler fra de seneste 2 år (ikke kun seneste måned)
- Returner KUN artikler du er 100% SIKKER på eksisterer med korrekte URLs
- INGEN engelske, norske eller svenske artikler — kun ovenstående danske medier
- INGEN artikler fra GlobeNewswire, Reuters, Bloomberg, AP — kun ovenstående danske medier
- Gæt IKKE URLs — skriv kun præcise links du kender med absolut sikkerhed
- Hvis du mangler artikler for at nå 10, søg bredere: brug ældre artikler (op til 2 år tilbage), brug flere medier

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
- Returner altid "socials"-objektet (evt. tomt {})`;

// ─── Response parser ─────────────────────────────────────────────────────────

/**
 * Parser Claude's JSON-svar med direkte artikelliste og sociale medier.
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

    // Parse artikler direkte fra JSON-arrayet
    const rawArticles: unknown[] = Array.isArray(raw.articles) ? raw.articles : [];

    const articles: ArticleResult[] = rawArticles
      .slice(0, 10)
      .filter(
        (a): a is Record<string, unknown> =>
          typeof a === 'object' &&
          a !== null &&
          typeof (a as Record<string, unknown>).title === 'string' &&
          typeof (a as Record<string, unknown>).url === 'string'
      )
      .filter((a) => {
        const url = String(a.url);
        // Afvis ikke-danske medier (GlobeNewswire, Reuters, Bloomberg m.fl.)
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

    for (const key of socialKeys) {
      const val = rawSocials[key];
      if (!val) continue;

      if (typeof val === 'string' && val.startsWith('https://')) {
        // Gammel format: direkte URL-streng
        socials[key] = val.trim();
      } else if (typeof val === 'object' && val !== null) {
        // Nyt format: { primary, alternatives }
        const entry = val as Record<string, unknown>;
        if (typeof entry.primary === 'string' && entry.primary.startsWith('https://')) {
          socials[key] = entry.primary.trim();
        }
        if (Array.isArray(entry.alternatives)) {
          const alts = (entry.alternatives as unknown[])
            .filter((a): a is string => typeof a === 'string' && a.startsWith('https://'))
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

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/article-search
 *
 * Beder Claude om at generere en liste af danske artikler om virksomheden
 * baseret på sin træningsviden. Ingen RSS-feeds eller Google News bruges.
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

  const userMessage = `Find de seneste danske artikler om denne virksomhed og returner sociale medier-links:\n\n${companyContext}`;

  const client = new Anthropic({ apiKey });

  try {
    console.log(`[article-search] Claude-søgning for "${companyName}"`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
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

    const { articles, socials, socialAlternatives } = parseArticleResponse(finalText);

    console.log(
      `[article-search] "${companyName}": ${articles.length} artikler, tokens=${totalTokens}`
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
