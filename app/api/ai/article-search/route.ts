/**
 * POST /api/ai/article-search
 *
 * AI-drevet artikelsøgning for virksomheder.
 *
 * Strategi (ingen web_search beta krævet):
 *   1. Henter artikler fra /api/news (danske RSS-feeds: Børsen, Berlingske, DR m.fl.)
 *   2. Sender rådata til Claude (ingen tools) for filtrering, rangering og beskrivelse
 *   3. Returnerer struktureret JSON med max 10 artikler + token-forbrug
 *
 * @param body.companyName  - Virksomhedens navn
 * @param body.cvr          - CVR-nummer (valgfrit)
 * @param body.industry     - Branchebeskrivelse (valgfrit)
 * @param body.employees    - Antal ansatte (valgfrit)
 * @param body.city         - By (valgfrit)
 * @param body.keyPersons   - Nøglepersoner: direktører, bestyrelsesmedlemmer (valgfrit)
 * @returns { articles, usage }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { rateLimit, AI_CHAT_LIMIT } from '@/app/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ──────────────────────────────────────────────────────────────────

/** En nyhedsartikel fundet via AI-søgning */
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

/** Sociale medier og hjemmeside-links fundet af Claude */
interface SocialsResult {
  website?: string;
  facebook?: string;
  linkedin?: string;
  instagram?: string;
  twitter?: string;
  youtube?: string;
}

/** Svar-format fra API'en */
interface ArticleSearchResponse {
  articles: ArticleResult[];
  socials: SocialsResult;
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

/** Råartikel fra /api/news */
interface RawNewsArticle {
  title: string;
  url: string;
  source: string;
  date?: string;
}

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Du er en AI-assistent specialiseret i at finde nyheder og officielle sociale medier-profiler for danske virksomheder.

Du modtager en liste af artikler hentet fra danske RSS-feeds og virksomhedsoplysninger.

Din opgave:
1. Filtrer og behold KUN artikler der direkte handler om den angivne virksomhed
2. Sortér nyeste artikler først
3. Tilføj en kort beskrivelse (max 120 tegn) til hver artikel baseret på titlen
4. Returner PRÆCIS 10 af de mest relevante artikler (eller færre hvis under 10 er relevante)
5. Find virksomhedens officielle sociale medier og hjemmeside baseret på virksomhedsnavnet

For sociale medier: brug din viden om kendte danske virksomheder til at angive de officielle URL'er.
Eksempel: Novo Nordisk → linkedin: "https://www.linkedin.com/company/novo-nordisk", website: "https://www.novonordisk.com"
Hvis du ikke kender den præcise URL, sæt feltet til null (medtag det ikke).

MEGET VIGTIGT: Returner KUN validt JSON i PRÆCIS dette format — ingen tekst før eller efter:

{
  "articles": [
    {
      "title": "Artiklens præcise titel",
      "url": "https://kildeUrl.dk/artikel",
      "source": "Kildens navn",
      "date": "Dato som tekst (bevar original format)",
      "description": "Kort beskrivelse på max 120 tegn"
    }
  ],
  "socials": {
    "website": "https://virksomhed.dk",
    "linkedin": "https://www.linkedin.com/company/virksomhed",
    "facebook": "https://www.facebook.com/virksomhed",
    "instagram": "https://www.instagram.com/virksomhed",
    "twitter": "https://x.com/virksomhed",
    "youtube": "https://www.youtube.com/@virksomhed"
  }
}

Udelad sociale medie-felter du ikke kender præcist (brug ikke google-søge-links, kun direkte profil-URLs).
Hvis ingen artikler er relevante: sæt "articles" til [] — men returner ALTID "socials" med de kendte URLs.`;

// ─── Response parser ─────────────────────────────────────────────────────────

/**
 * Udtrækker JSON fra Claude's tekstsvar og parser det til strukturerede data.
 *
 * @param text - Rå tekstsvar fra Claude
 * @returns Parsede artikler og sociale medier-links
 */
function parseArticleResponse(text: string): { articles: ArticleResult[]; socials: SocialsResult } {
  const empty = { articles: [], socials: {} };
  try {
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ??
      text.match(/```\s*([\s\S]*?)\s*```/) ??
      text.match(/(\{[\s\S]*\})/);

    if (!jsonMatch) return empty;

    const raw = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);

    const articles: ArticleResult[] = (raw.articles ?? [])
      .filter(
        (a: Record<string, unknown>) =>
          typeof a.title === 'string' && typeof a.url === 'string' && a.url.startsWith('http')
      )
      .slice(0, 10)
      .map((a: Record<string, unknown>) => ({
        title: String(a.title ?? '').trim(),
        url: String(a.url ?? '').trim(),
        source: String(a.source ?? '').trim(),
        date: a.date ? String(a.date).trim() : undefined,
        description: a.description ? String(a.description).trim().slice(0, 150) : undefined,
      }));

    // Udtræk sociale medier — bevar kun felter med gyldige https-URLs
    const rawSocials = raw.socials ?? {};
    const socials: SocialsResult = {};
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
      if (typeof val === 'string' && val.startsWith('https://')) {
        socials[key] = val.trim();
      }
    }

    return { articles, socials };
  } catch {
    return empty;
  }
}

// ─── News fetcher ────────────────────────────────────────────────────────────

/**
 * Henter artikler fra den interne /api/news route (danske RSS-feeds).
 * Forsøger med fuldt virksomhedsnavn, derefter første ord som fallback.
 *
 * @param baseUrl - App-base URL (f.eks. https://test.bizzassist.dk)
 * @param companyName - Virksomhedens navn til søgning
 * @returns Liste af råartikler
 */
async function fetchRssArticles(baseUrl: string, companyName: string): Promise<RawNewsArticle[]> {
  try {
    const res = await fetch(`${baseUrl}/api/news?q=${encodeURIComponent(companyName)}`, {
      headers: { 'User-Agent': 'BizzAssist-Internal/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[article-search] fetchRssArticles fejl:', err);
    return [];
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/article-search
 *
 * Henter nyheder via /api/news (RSS) og bruger Claude til filtrering og rangering.
 * Kræver ikke web_search beta-adgang.
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

  // Udled base URL fra request (virker både lokalt og på Vercel)
  const host = request.headers.get('host') ?? 'localhost:3000';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? `${protocol}://${host}`;

  // Hent artikler fra /api/news (danske RSS-feeds — gratis, ingen beta krævet)
  const rawArticles = await fetchRssArticles(baseUrl, companyName);
  console.log(
    `[article-search] RSS-feed resultater for "${companyName}": ${rawArticles.length} artikler`
  );

  // Byg virksomhedskontekst
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

  // Formatér råartikler til Claude-input
  const articlesSection =
    rawArticles.length > 0
      ? `\n\nArtikler fundet i danske medier (${rawArticles.length} stk.):\n${rawArticles
          .map(
            (a, i) =>
              `${i + 1}. Titel: "${a.title}"\n   Kilde: ${a.source}${a.date ? ` (${a.date})` : ''}\n   URL: ${a.url}`
          )
          .join('\n')}`
      : '\n\nIngen artikler fundet i RSS-feeds for denne søgning. Returner {"articles": []}.';

  const userMessage = `Filtrer og rangér disse nyheder om følgende virksomhed:\n\n${companyContext}${articlesSection}`;

  const client = new Anthropic({ apiKey });

  try {
    // Enkelt Claude-kald uden tools — samme pattern som AI Business Assistent
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
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

    const { articles, socials } = parseArticleResponse(finalText);
    if (articles.length === 0) {
      console.warn(
        '[article-search] Claude svarede men ingen artikler kunne parses. Råsvar:',
        finalText.slice(0, 500)
      );
    }

    const result: ArticleSearchResponse = {
      articles,
      socials,
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
