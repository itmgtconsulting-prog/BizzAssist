/**
 * GET /api/news?q=Novo+Nordisk
 *
 * Aggregerer nyheder fra flere kilder:
 *   1. Ritzau Via API (pressemeddelelser) — hvis RITZAU_PUBLISHER + RITZAU_CHANNEL er sat
 *   2. Ritzau Nyhedstjenesten API — hvis RITZAU_NEWS_API_KEY er sat
 *   3. Fallback: Direkte danske RSS-feeds (Børsen, Berlingske, Politiken, DR, Altinget m.fl.)
 *
 * Returnerer kun artikler der matcher søgetermen — sorteret nyeste først.
 *
 * @param q - Søgeterm (virksomhedsnavn eller personnavn)
 * @returns Array af { title, url, source, sourceDomain, favicon, date }
 */

import { NextRequest, NextResponse } from 'next/server';

interface NewsArticle {
  title: string;
  url: string;
  source: string;
  sourceDomain: string;
  favicon: string;
  date?: string;
  timestamp: number;
}

// ─── HTML Entity Decoder ────────────────────────────────────────────────────

/** Decode HTML entities (&#230; → æ osv.) */
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
    .replace(/&aring;/g, 'å')
    .replace(/&Oslash;/g, 'Ø')
    .replace(/&AElig;/g, 'Æ')
    .replace(/&Aring;/g, 'Å');
}

// ─── Ritzau Via API (pressemeddelelser) ─────────────────────────────────────

/**
 * Henter pressemeddelelser fra Via Ritzau API og filtrerer efter søgeterm.
 * Kræver RITZAU_PUBLISHER og RITZAU_CHANNEL env vars.
 */
async function fetchRitzauVia(searchTerms: string[]): Promise<NewsArticle[]> {
  const publisher = process.env.RITZAU_PUBLISHER;
  const channel = process.env.RITZAU_CHANNEL;
  if (!publisher || !channel) return [];

  try {
    const res = await fetch(
      `https://via.ritzau.dk/json/v2/releases?publisher=${publisher}&channels=${channel}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return [];

    const json = await res.json();
    const releases = Array.isArray(json) ? json : (json.releases ?? json.data ?? []);

    const articles: NewsArticle[] = [];
    for (const r of releases) {
      const title = (r.title ?? r.headline ?? '').trim();
      const url = r.url ?? r.Url ?? '';
      if (!title || !url) continue;

      // Match søgetermer i titel og evt. brødtekst
      const body = (r.body ?? r.text ?? r.summary ?? '').replace(/<[^>]+>/g, '');
      const searchText = (title + ' ' + body).toLowerCase();
      if (!searchTerms.every((term) => searchText.includes(term))) continue;

      let timestamp = 0;
      let date: string | undefined;
      const pubDate = r.published ?? r.publishedDate ?? r.created ?? null;
      if (pubDate) {
        try {
          const d = new Date(pubDate);
          timestamp = d.getTime();
          date = d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
        } catch {
          /* ignore */
        }
      }

      articles.push({
        title,
        url,
        source: 'Ritzau',
        sourceDomain: 'ritzau.dk',
        favicon: 'https://www.google.com/s2/favicons?sz=32&domain=ritzau.dk',
        date,
        timestamp,
      });
    }

    return articles;
  } catch {
    return [];
  }
}

// ─── Ritzau Nyhedstjenesten API ─────────────────────────────────────────────

/**
 * Henter nyheder fra Ritzau Nyhedstjenesten API.
 * Kræver RITZAU_NEWS_API_KEY env var.
 * Endpoint og auth-metode tilpasses når API-nøgle og dokumentation er tilgængelig.
 */
async function fetchRitzauNews(query: string): Promise<NewsArticle[]> {
  const apiKey = process.env.RITZAU_NEWS_API_KEY;
  if (!apiKey) return [];

  try {
    // Ritzau Nyhedstjenesten endpoint — tilpasses når API-dokumentation er tilgængelig
    const res = await fetch(
      `https://api.ritzau.dk/v1/news?q=${encodeURIComponent(query)}&limit=15`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) {
      console.log('[news] Ritzau Nyhedstjenesten returned', res.status);
      return [];
    }

    const json = await res.json();
    const items = Array.isArray(json) ? json : (json.articles ?? json.items ?? json.data ?? []);

    return items
      .slice(0, 15)
      .map((item: Record<string, unknown>) => {
        const title = (item.title ?? item.headline ?? '') as string;
        const url = (item.url ?? item.link ?? '') as string;
        const source = (item.source ?? item.medie ?? 'Ritzau') as string;

        let timestamp = 0;
        let date: string | undefined;
        const pubDate = (item.published ??
          item.publishedAt ??
          item.date ??
          item.created ??
          null) as string | null;
        if (pubDate) {
          try {
            const d = new Date(pubDate);
            timestamp = d.getTime();
            date = d.toLocaleDateString('da-DK', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            });
          } catch {
            /* ignore */
          }
        }

        // Forsøg at finde domæne fra URL
        let sourceDomain = 'ritzau.dk';
        try {
          sourceDomain = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          /* ignore */
        }

        return {
          title: title.trim(),
          url,
          source: source.trim(),
          sourceDomain,
          favicon: `https://www.google.com/s2/favicons?sz=32&domain=${sourceDomain}`,
          date,
          timestamp,
        };
      })
      .filter((a: NewsArticle) => a.title && a.url);
  } catch (err) {
    console.error('[news] Ritzau Nyhedstjenesten error:', err);
    return [];
  }
}

// ─── Direkte danske RSS-feeds (fallback) ────────────────────────────────────

/** Danske RSS-feeds — verificerede og fungerende */
const RSS_FEEDS = [
  { name: 'Børsen', domain: 'borsen.dk', url: 'https://borsen.dk/rss' },
  { name: 'Berlingske', domain: 'berlingske.dk', url: 'https://www.berlingske.dk/content/rss' },
  { name: 'Politiken', domain: 'politiken.dk', url: 'https://politiken.dk/rss/senestenyt.rss' },
  {
    name: 'DR Nyheder',
    domain: 'dr.dk',
    url: 'https://www.dr.dk/nyheder/service/feeds/senestenyt',
  },
  { name: 'DR Penge', domain: 'dr.dk', url: 'https://www.dr.dk/nyheder/service/feeds/penge' },
  { name: 'Altinget', domain: 'altinget.dk', url: 'https://www.altinget.dk/rss' },
  { name: 'Ingeniøren', domain: 'ing.dk', url: 'https://ing.dk/rss' },
  { name: 'Version2', domain: 'version2.dk', url: 'https://www.version2.dk/rss' },
];

/** Parse RSS XML og returnér artikler der matcher søgetermen */
function parseRssFeed(
  xml: string,
  feedName: string,
  feedDomain: string,
  searchTerms: string[]
): NewsArticle[] {
  const articles: NewsArticle[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];

    const titleMatch =
      item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ?? item.match(/<title>(.*?)<\/title>/);
    const title = decodeHtmlEntities((titleMatch?.[1] ?? '').trim());
    if (!title) continue;

    const linkMatch = item.match(/<link>(.*?)<\/link>/) ?? item.match(/<link\s*\/?>([^<\s]+)/);
    const url = (linkMatch?.[1] ?? '').trim();
    if (!url || !url.startsWith('http')) continue;

    const descMatch =
      item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ??
      item.match(/<description>(.*?)<\/description>/);
    const desc = decodeHtmlEntities((descMatch?.[1] ?? '').replace(/<[^>]+>/g, ''));

    const searchText = (title + ' ' + desc).toLowerCase();
    if (!searchTerms.every((term) => searchText.includes(term))) continue;

    let date: string | undefined;
    let timestamp = 0;
    const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
    if (pubDateMatch?.[1]) {
      try {
        const d = new Date(pubDateMatch[1]);
        timestamp = d.getTime();
        date = d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
      } catch {
        /* ignore */
      }
    }

    articles.push({
      title,
      url,
      source: feedName,
      sourceDomain: feedDomain,
      favicon: `https://www.google.com/s2/favicons?sz=32&domain=${feedDomain}`,
      date,
      timestamp,
    });
  }

  return articles;
}

/** Henter og parser alle danske RSS-feeds parallelt */
async function fetchDanskeRssFeeds(searchTerms: string[]): Promise<NewsArticle[]> {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BizzAssist/1.0)' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return parseRssFeed(xml, feed.name, feed.domain, searchTerms);
    })
  );

  const articles: NewsArticle[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') articles.push(...r.value);
  }
  return articles;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? '';
  if (!q.trim()) {
    return NextResponse.json([], { status: 200 });
  }

  const searchTerms = q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (searchTerms.length === 0) {
    return NextResponse.json([], { status: 200 });
  }

  try {
    // Hent fra alle kilder parallelt — Ritzau har prioritet
    const [ritzauNews, ritzauVia, rssArticles] = await Promise.all([
      fetchRitzauNews(q),
      fetchRitzauVia(searchTerms),
      fetchDanskeRssFeeds(searchTerms),
    ]);

    // Saml alle artikler — Ritzau Nyhedstjenesten først, derefter Via, derefter RSS
    const allArticles: NewsArticle[] = [];
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();

    for (const article of [...ritzauNews, ...ritzauVia, ...rssArticles]) {
      if (seenUrls.has(article.url)) continue;
      const normalTitle = article.title
        .toLowerCase()
        .replace(/[^a-zæøå0-9]/g, '')
        .slice(0, 60);
      if (seenTitles.has(normalTitle)) continue;
      seenUrls.add(article.url);
      seenTitles.add(normalTitle);
      allArticles.push(article);
    }

    // Sortér nyeste først
    allArticles.sort((a, b) => b.timestamp - a.timestamp);

    // Returnér max 10
    const response = allArticles.slice(0, 10).map(({ timestamp: _, ...rest }) => rest);

    return NextResponse.json(response, {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=900, s-maxage=1800' },
    });
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}
