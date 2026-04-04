/**
 * POST /api/ai/article-search/socials
 *
 * Split-endpoint til progressiv loading — verificerer KUN sociale medie-profiler for en dansk virksomhed.
 * Del af parallelt søge-flow: kald dette endpoint sideløbende med /articles.
 *
 * Strategi:
 * 1. Brave Search — søger hjemmeside, Facebook, LinkedIn, Instagram, Twitter, YouTube (6 parallelle queries)
 * 2. Claude — verificerer og confidence-scorer hvert profil-link
 * 3. Supabase — henter confidence-tærskel og lærings-kontekst
 *
 * @param body.companyName  - Virksomhedens navn
 * @param body.cvr          - CVR-nummer (valgfrit)
 * @param body.industry     - Branchebeskrivelse (valgfrit)
 * @param body.employees    - Antal ansatte (valgfrit)
 * @param body.city         - By (valgfrit)
 * @param body.keyPersons   - Nøglepersoner (valgfrit)
 * @returns { socialsWithMeta, alternativesWithMeta, socials, socialAlternatives, confidenceThreshold, tokensUsed }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { rateLimit, AI_CHAT_LIMIT } from '@/app/lib/rateLimit';
import { withBraveCache } from '@/app/lib/searchCache';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Sociale medier og hjemmeside-links */
interface SocialsResult {
  website?: string;
  facebook?: string;
  linkedin?: string;
  instagram?: string;
  twitter?: string;
  youtube?: string;
}

/** Et socialt medie-link med confidence metadata */
interface SocialWithMeta {
  url: string;
  confidence: number;
  reason?: string;
}

/** Input-format */
interface CompanyInput {
  companyName: string;
  cvr?: string;
  industry?: string;
  employees?: number | string;
  city?: string;
  keyPersons?: string[];
}

/** Brave-resultat råformat */
interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  meta_url?: { hostname?: string };
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const DEFAULT_THRESHOLD = 70;

/**
 * Henter confidence-tærskel fra ai_settings-tabellen.
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
 * Bygger lærings-kontekst fra verificerings-data i Supabase.
 *
 * @returns Formateret kontekst-streng til Claude's system prompt
 */
async function buildLearningContext(): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return '';
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await client
      .from('link_verification_counts')
      .select('platform, verified_count, rejected_count')
      .not('platform', 'is', null);
    if (!data || data.length === 0) return '';
    const stats: Record<string, { verified: number; rejected: number; total: number }> = {};
    for (const row of data) {
      const p = row.platform as string;
      if (!stats[p]) stats[p] = { verified: 0, rejected: 0, total: 0 };
      stats[p].verified += Number(row.verified_count) || 0;
      stats[p].rejected += Number(row.rejected_count) || 0;
      stats[p].total += (Number(row.verified_count) || 0) + (Number(row.rejected_count) || 0);
    }
    const lines: string[] = [];
    for (const [platform, s] of Object.entries(stats)) {
      if (s.total < 3) continue;
      lines.push(
        `- ${platform}: ${Math.round((s.verified / s.total) * 100)}% godkendelsesrate (${s.total} stemmer)`
      );
    }
    if (lines.length === 0) return '';
    return `\n\nLærings-kontekst fra bruger-verificeringer:\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

// ─── Brave Search ─────────────────────────────────────────────────────────────

/**
 * Søger sociale medier-profiler for en virksomhed via Brave Search (6 parallelle queries).
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
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(p.query)}&count=${p.count}&country=dk`;
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
  return socials;
}

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Bygger system prompt til verificering af sociale medie-profiler for en virksomhed.
 *
 * @param learningContext - Aggregerede verificerings-statistikker per platform
 * @returns Komplet system prompt til Claude
 */
function buildSocialsSystemPrompt(learningContext: string): string {
  return `Du er en dansk ekspert. Du verificerer sociale medie-profiler og hjemmeside for en dansk VIRKSOMHED.

Confidence-regler:
- 90-100: Meget sikker — officielt domæne matcher eksakt, /company/ URL med korrekt slug
- 75-89: Ret sikker — stærke indikatorer men ikke perfekt match
- 60-74: Usikkert — delvist match
- Under 50: Udelad platformen helt
- Returner ALDRIG generiske roddomæner (f.eks. "https://facebook.com/")${learningContext}

Returner KUN validt JSON uden tekst før/efter:

{
  "socials": {
    "website": {
      "url": "https://virksomhed.dk",
      "confidence": 95,
      "reason": "Officielt domæne matcher virksomhedsnavnet",
      "alternatives": []
    },
    "linkedin": {
      "url": "https://www.linkedin.com/company/slug",
      "confidence": 88,
      "reason": "LinkedIn /company/ URL med navn der matcher",
      "alternatives": []
    }
  }
}

- Udelad platforme du ikke kender (udelad feltet helt)
- "alternatives"-arrayet kan være tomt [] men skal altid inkluderes`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * Validerer at en streng er en gyldig URL.
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
 * Parser Claude's JSON-svar — udtrækker sociale medie-links med confidence metadata.
 *
 * @param text      - Rå tekstsvar fra Claude
 * @param threshold - Confidence-tærskel
 */
function parseSocialsResponse(
  text: string,
  threshold: number
): {
  socials: SocialsResult;
  socialAlternatives: Record<string, string[]>;
  socialsWithMeta: Record<string, SocialWithMeta>;
  alternativesWithMeta: Record<string, SocialWithMeta[]>;
} {
  const empty = {
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
    const rawSocials: unknown = raw.socials;
    if (typeof rawSocials !== 'object' || rawSocials === null) return empty;

    const socials: SocialsResult = {};
    const socialAlternatives: Record<string, string[]> = {};
    const socialsWithMeta: Record<string, SocialWithMeta> = {};
    const alternativesWithMeta: Record<string, SocialWithMeta[]> = {};

    for (const [key, value] of Object.entries(rawSocials as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const primaryUrl = typeof v.url === 'string' ? v.url.trim() : null;
      if (!primaryUrl || !isValidUrl(primaryUrl)) continue;

      const confidence =
        typeof v.confidence === 'number'
          ? Math.max(0, Math.min(100, Math.round(v.confidence)))
          : 75;
      const reason = typeof v.reason === 'string' ? v.reason.trim() : undefined;

      const rawAlts: unknown[] = Array.isArray(v.alternatives) ? v.alternatives : [];
      const altsWithMeta = rawAlts
        .map((ao): SocialWithMeta | null => {
          if (typeof ao !== 'object' || ao === null) return null;
          const a = ao as Record<string, unknown>;
          const url = typeof a.url === 'string' ? a.url.trim() : null;
          if (!url || !isValidUrl(url)) return null;
          return {
            url,
            confidence:
              typeof a.confidence === 'number'
                ? Math.max(0, Math.min(100, Math.round(a.confidence)))
                : 75,
            reason: typeof a.reason === 'string' ? a.reason.trim() : undefined,
          };
        })
        .filter((a): a is SocialWithMeta => a !== null)
        .filter((a) => a.url !== primaryUrl && !isSameBaseDomain(a.url, primaryUrl))
        .slice(0, 5);

      if (confidence >= threshold) {
        socials[key as keyof SocialsResult] = primaryUrl;
        socialsWithMeta[key] = { url: primaryUrl, confidence, reason };
      } else {
        altsWithMeta.unshift({ url: primaryUrl, confidence, reason });
      }

      if (altsWithMeta.length > 0) {
        alternativesWithMeta[key] = altsWithMeta;
        socialAlternatives[key] = altsWithMeta.map((a) => a.url);
      }
    }

    return { socials, socialAlternatives, socialsWithMeta, alternativesWithMeta };
  } catch {
    return empty;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/article-search/socials
 * Verificerer sociale medie-profiler for en virksomhed via Brave Search + Claude.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = rateLimit(request, AI_CHAT_LIMIT);
  if (limited) return NextResponse.json({ error: 'Rate limit overskredet' }, { status: 429 });

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey)
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });

  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!braveKey)
    return NextResponse.json({ error: 'BRAVE_SEARCH_API_KEY ikke konfigureret' }, { status: 500 });

  let body: CompanyInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { companyName, cvr, city } = body;
  if (!companyName?.trim())
    return NextResponse.json({ error: 'companyName er påkrævet' }, { status: 400 });

  // ── Brave-søgning + Supabase parallelt ──
  // Brave socials results are cached 24h in Supabase search_cache to reduce API usage.
  let braveSocials: SocialsResult;
  let confidenceThreshold: number;
  let learningContext: string;

  try {
    [braveSocials, confidenceThreshold, learningContext] = await Promise.all([
      withBraveCache(`socials|${companyName.toLowerCase()}|${cvr ?? ''}`, () =>
        searchBraveSocials(braveKey, companyName)
      ),
      fetchConfidenceThreshold(),
      buildLearningContext(),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Brave Search fejl';
    return NextResponse.json({ error: `Søgning fejlede: ${msg}` }, { status: 502 });
  }

  // ── Byg Claude-besked ──
  const companyContext = [
    `Virksomhedsnavn: ${companyName}`,
    cvr ? `CVR-nummer: ${cvr}` : null,
    city ? `By: ${city}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const locationHint = city ? ` i ${city}` : ' i Danmark';
  const socialsStr =
    Object.keys(braveSocials).length > 0
      ? Object.entries(braveSocials)
          .map(([platform, url]) => `- ${platform}: ${url}`)
          .join('\n')
      : '(Ingen sociale medie-profiler fundet)';

  const userMessage =
    `Virksomhed:\n${companyContext}\n\nBrave Search har fundet disse sociale medie-profiler — verificer om de tilhører NETOP DENNE virksomhed${locationHint}:\n${socialsStr}\n\n` +
    `Brug dem i din socials-output med passende confidence-score. Hvis en profil tilhører en anden virksomhed, giv den lav confidence eller udelad den.`;

  // ── Kald Claude ──
  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSocialsSystemPrompt(learningContext),
      messages: [{ role: 'user', content: userMessage }],
    });

    const totalTokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    const finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const {
      socials: claudeSocials,
      socialAlternatives,
      socialsWithMeta,
      alternativesWithMeta,
    } = parseSocialsResponse(finalText, confidenceThreshold);

    const socials: SocialsResult = { ...braveSocials, ...claudeSocials };

    console.log(
      `[article-search/socials] "${companyName}": primære=[${Object.keys(socialsWithMeta).join(',')}], tokens=${totalTokens}`
    );

    return NextResponse.json({
      socials,
      socialAlternatives,
      socialsWithMeta,
      alternativesWithMeta,
      confidenceThreshold,
      tokensUsed: totalTokens,
      source: 'brave+claude',
    });
  } catch (err) {
    const msg =
      err instanceof Anthropic.APIError
        ? `API-fejl (${err.status}): ${err.message}`
        : err instanceof Error
          ? err.message
          : 'Ukendt fejl';
    return NextResponse.json({ error: msg, socials: {}, socialsWithMeta: {} }, { status: 500 });
  }
}
