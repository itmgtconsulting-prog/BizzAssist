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

/**
 * System prompt bruger index-baseret output for at minimere tokens.
 * Claude returnerer kun indeks-numre + korte beskrivelser, IKKE fulde URLs.
 * Det holder output under 400 tokens og undgår JSON-truncation ved max_tokens.
 */
const SYSTEM_PROMPT = `Du er assistent der analyserer nyhedsartikler og sociale medier for danske virksomheder.

Du modtager en nummereret liste af artikler og virksomhedsoplysninger.

Returner KUN validt JSON uden tekst før/efter:

{
  "selected": [1, 3, 5],
  "descriptions": ["Max 80 tegn beskrivelse af artikel 1", "Max 80 tegn beskrivelse af artikel 3", "Max 80 tegn beskrivelse af artikel 5"],
  "socials": {
    "website": "https://virksomhed.dk",
    "linkedin": "https://www.linkedin.com/company/slug",
    "facebook": "https://www.facebook.com/slug",
    "instagram": "https://www.instagram.com/slug",
    "twitter": "https://x.com/slug",
    "youtube": "https://www.youtube.com/@slug"
  }
}

Regler:
- "selected": op til 8 artiklernes numre (1-baseret), sortér nyeste/mest relevante først
- "descriptions": ét element per valgt artikel i samme rækkefølge, max 80 tegn
- "socials": kun URL'er du kender præcist — udelad felter du er usikker på
- Returner altid "socials" selvom selected er tom`;

// ─── Response parser ─────────────────────────────────────────────────────────

/**
 * Parser Claude's index-baserede svar og rekonstruerer artikler fra rawArticles.
 * Index-format minimerer output-tokens: Claude returnerer kun numre + korte beskrivelser.
 *
 * @param text - Rå tekstsvar fra Claude (JSON med selected[], descriptions[], socials{})
 * @param rawArticles - De originale artikler fra Google News RSS
 * @returns Rekonstruerede artikler og sociale medier-links
 */
function parseArticleResponse(
  text: string,
  rawArticles: RawNewsArticle[]
): { articles: ArticleResult[]; socials: SocialsResult } {
  const empty = { articles: [], socials: {} };
  try {
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ??
      text.match(/```\s*([\s\S]*?)\s*```/) ??
      text.match(/(\{[\s\S]*\})/);

    if (!jsonMatch) return empty;

    const raw = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);

    // Rekonstruér artikler fra index-numre (1-baseret)
    const selected: number[] = Array.isArray(raw.selected) ? raw.selected : [];
    const descriptions: string[] = Array.isArray(raw.descriptions) ? raw.descriptions : [];

    const articles: ArticleResult[] = selected
      .slice(0, 8)
      .reduce<ArticleResult[]>((acc, idx: number, position: number) => {
        const article = rawArticles[idx - 1]; // konvertér til 0-baseret
        if (!article) return acc;
        acc.push({
          title: article.title,
          url: article.url,
          source: article.source,
          date: article.date,
          description: descriptions[position]
            ? String(descriptions[position]).trim().slice(0, 100)
            : undefined,
        });
        return acc;
      }, []);

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

// ─── Google News RSS fetcher (inline — ingen HTTP-rundtur) ───────────────────

/** Decode HTML entities fra RSS */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&oslash;/g, 'ø')
    .replace(/&aelig;/g, 'æ')
    .replace(/&aring;/g, 'å');
}

/**
 * Henter søgespecifikke artikler direkte fra Google News RSS.
 * Inlines logikken i stedet for at kalde /api/news for at undgå timeout-kæden.
 * Timeout: 5s — tilpasset Vercel Hobby plan (10s total limit).
 *
 * @param companyName - Virksomhedens navn
 * @returns Op til 15 artikler om virksomheden
 */
async function fetchGoogleNewsArticles(companyName: string): Promise<RawNewsArticle[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(companyName)}&hl=da&gl=DK&ceid=DK:da`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BizzAssist/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const xml = await res.text();

    const articles: RawNewsArticle[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null && articles.length < 15) {
      const item = match[1];

      const titleMatch =
        item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ?? item.match(/<title>(.*?)<\/title>/);
      const title = decodeHtmlEntities((titleMatch?.[1] ?? '').trim());
      if (!title) continue;

      const linkMatch = item.match(/<link>(.*?)<\/link>/) ?? item.match(/<link\s*\/?>([^<\s]+)/);
      const articleUrl = (linkMatch?.[1] ?? '').trim();
      if (!articleUrl || !articleUrl.startsWith('http')) continue;

      // Faktisk udgiver fra <source> tag
      let source = 'Google News';
      const sourceMatch = item.match(/<source[^>]*url="[^"]*"[^>]*>(.*?)<\/source>/);
      if (sourceMatch) source = decodeHtmlEntities(sourceMatch[1].trim()) || source;

      let date: string | undefined;
      const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      if (pubDateMatch?.[1]) {
        try {
          date = new Date(pubDateMatch[1]).toLocaleDateString('da-DK', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          });
        } catch {
          /* ignore */
        }
      }

      articles.push({ title, url: articleUrl, source, date });
    }

    return articles;
  } catch (err) {
    console.error('[article-search] Google News RSS fejl:', err);
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

  // Hent artikler direkte fra Google News RSS (ingen HTTP-rundtur til /api/news)
  const rawArticles = await fetchGoogleNewsArticles(companyName);
  console.log(
    `[article-search] Google News resultater for "${companyName}": ${rawArticles.length} artikler`
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

  // Formatér råartikler til Claude-input — kun titel + kilde + dato (ingen URL = færre tokens)
  const articlesSection =
    rawArticles.length > 0
      ? `\n\nArtikler (${rawArticles.length} stk.) — angiv numre i "selected":\n${rawArticles
          .map((a, i) => `${i + 1}. "${a.title}" — ${a.source}${a.date ? ` (${a.date})` : ''}`)
          .join('\n')}`
      : '\n\nIngen artikler fundet. Returner {"selected":[],"descriptions":[],"socials":{...}}';

  const userMessage = `Filtrer og rangér disse nyheder om følgende virksomhed:\n\n${companyContext}${articlesSection}`;

  const client = new Anthropic({ apiKey });

  try {
    // Haiku bruges for hastighed (2-3s vs. 6-8s for Sonnet) — vigtigt for Vercel timeout
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
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

    const { articles, socials } = parseArticleResponse(finalText, rawArticles);
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
