/**
 * POST /api/ai/person-search/socials
 *
 * Split-endpoint til progressiv loading — verificerer KUN sociale medie-profiler for en dansk person.
 * Del af parallelt søge-flow: kald dette endpoint sideløbende med /articles og /contacts.
 *
 * Strategi:
 * 1. Brave Search — søger LinkedIn, Facebook, Instagram, X/Twitter (8 parallelle queries)
 * 2. Claude — verificerer og confidence-scorer hvert profil-link
 * 3. Supabase — henter confidence-tærskel og lærings-kontekst
 *
 * @param body.personName   - Personens fulde navn
 * @param body.companies    - Tilknyttede virksomheder (valgfrit, til kontekst)
 * @param body.city         - By (valgfrit, til disambiguation)
 * @returns { socialsWithMeta, alternativesWithMeta, socials, socialAlternatives, confidenceThreshold, tokensUsed }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, braveRateLimit } from '@/app/lib/rateLimit';
import { withBraveCache } from '@/app/lib/searchCache';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Sociale medier-links */
interface SocialsResult {
  website?: string;
  facebook?: string;
  linkedin?: string;
  instagram?: string;
  twitter?: string;
}

/** Et socialt medie-link med confidence metadata */
interface SocialWithMeta {
  url: string;
  confidence: number;
  reason?: string;
}

/** Input-format */
interface PersonInput {
  personName: string;
  companies?: Array<{ cvr: number | string; name: string; role?: string }>;
  city?: string;
}

/** Brave-resultat råformat */
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
const DEFAULT_THRESHOLD = 70;

/** Standard-platforme der søges hvis ingen konfiguration er tilgængelig */
const DEFAULT_ENABLED_PLATFORMS = ['linkedin', 'facebook', 'instagram', 'twitter'];

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
 * Henter liste af aktiverede sociale platforme fra ai_settings-tabellen.
 * Bruges til at filtrere hvilke platforme der søges for personer.
 *
 * @returns Array af aktiverede platform-nøgler (f.eks. ['linkedin', 'facebook'])
 */
async function fetchEnabledPlatforms(): Promise<string[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return DEFAULT_ENABLED_PLATFORMS;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await client
      .from('ai_settings')
      .select('value')
      .eq('key', 'enabled_social_platforms')
      .single();
    if (Array.isArray(data?.value) && data.value.length > 0) {
      return data.value as string[];
    }
    return DEFAULT_ENABLED_PLATFORMS;
  } catch {
    return DEFAULT_ENABLED_PLATFORMS;
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
      const rate = Math.round((s.verified / s.total) * 100);
      lines.push(`- ${platform}: ${rate}% godkendelsesrate (${s.total} stemmer)`);
    }
    if (lines.length === 0) return '';
    return `\n\nLærings-kontekst fra bruger-verificeringer:\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

// ─── Brave Search ─────────────────────────────────────────────────────────────

/**
 * Søger én platform på Brave og returnerer unikke profil-URLs.
 *
 * @param key          - Brave Search Subscription Token
 * @param query        - Søgeforespørgsel
 * @param count        - Antal resultater ønsket
 * @param domainFilter - Valgfrit domæne-filter (f.eks. "facebook.com")
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
        if (!u) return false;
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
 * Søger personens sociale medier-profiler via Brave Search (parallelle queries).
 * Søger kun de platforme der er aktiveret i ai_settings (enabled_social_platforms).
 *
 * @param key              - Brave Search Subscription Token
 * @param personName       - Personens fulde navn
 * @param enabledPlatforms - Platforme der er aktiveret i admin-indstillingerne
 */
async function searchBravePersonSocials(
  key: string,
  personName: string,
  enabledPlatforms: string[]
): Promise<{ socials: SocialsResult; allCandidates: Record<string, string[]> }> {
  type QueryDef = { query: string; domainFilter?: string };
  type PlatformDef = { name: keyof SocialsResult; queries: QueryDef[]; count: number };

  // Alle understøttede platforme med søge-templates
  const allPlatforms: PlatformDef[] = [
    {
      name: 'linkedin',
      queries: [
        { query: `"${personName}" site:linkedin.com/in` },
        { query: `"${personName}" LinkedIn`, domainFilter: 'linkedin.com' },
      ],
      count: 3,
    },
    {
      name: 'facebook',
      queries: [
        { query: `"${personName}" site:facebook.com` },
        { query: `"${personName}" Facebook`, domainFilter: 'facebook.com' },
      ],
      count: 3,
    },
    {
      name: 'instagram',
      queries: [
        { query: `"${personName}" site:instagram.com` },
        { query: `"${personName}" Instagram`, domainFilter: 'instagram.com' },
      ],
      count: 2,
    },
    {
      name: 'twitter',
      queries: [
        { query: `"${personName}" site:x.com OR site:twitter.com` },
        { query: `"${personName}" Twitter`, domainFilter: 'x.com' },
      ],
      count: 2,
    },
  ];

  // Filtrer til kun aktiverede platforme
  const platforms = allPlatforms.filter((p) => enabledPlatforms.includes(p.name));

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
    if (urls && urls.length > 0) socials[name as keyof SocialsResult] = urls[0];
  }

  return { socials, allCandidates: platformUrls as Record<string, string[]> };
}

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Bygger system prompt til verificering af sociale medie-profiler for en person.
 *
 * @param learningContext - Aggregerede verificerings-statistikker per platform
 * @returns Komplet system prompt til Claude
 */
function buildSocialsSystemPrompt(learningContext: string): string {
  return `Du er en dansk ekspert. Du verificerer sociale medie-profil-links for en dansk PERSON.
Vigtig: LinkedIn /in/ URL er personlig profil — returner ALDRIG /company/ URL.

Confidence-regler (PERSON-specifik):
- 90-100: Meget sikker — præcist navnematch + korrekt kontekst (by, virksomhed)
- 75-89: Ret sikker — stærkt navnematch
- 60-74: Usikkert — muligvis en anden med samme navn
- Under 50: Udelad platformen helt
- Returner ALDRIG generiske roddomæner (f.eks. "https://facebook.com/")${learningContext}

Returner KUN validt JSON uden tekst før/efter:

{
  "socials": {
    "linkedin": {
      "url": "https://www.linkedin.com/in/slug",
      "confidence": 88,
      "reason": "LinkedIn /in/ profil med fuldt navn-match",
      "alternatives": []
    },
    "facebook": {
      "url": "https://www.facebook.com/slug",
      "confidence": 72,
      "reason": "Profil med navn der matcher",
      "alternatives": [{"url": "https://www.facebook.com/altslug", "confidence": 55, "reason": "Alternativ"}]
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
 * Parser Claude's JSON-svar — udtrækker kun sociale medie-links med confidence metadata.
 *
 * @param text      - Rå tekstsvar fra Claude
 * @param threshold - Confidence-tærskel: primære links under denne score flyttes til alternativer
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

      // Alternativer
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
        // Primært under tærskel — flyt til alternativer
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
 * POST /api/ai/person-search/socials
 * Verificerer sociale medie-profiler for en person via Brave Search + Claude.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, braveRateLimit);
  if (limited) return limited;

  // Require an authenticated session
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey)
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });

  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!braveKey)
    return NextResponse.json({ error: 'BRAVE_SEARCH_API_KEY ikke konfigureret' }, { status: 500 });

  let body: PersonInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { personName, companies = [], city } = body;
  if (!personName?.trim())
    return NextResponse.json({ error: 'personName er påkrævet' }, { status: 400 });

  // ── Supabase-indstillinger + Brave-søgning ──
  // Henter konfiguration parallelt, derefter søger med aktiverede platforme.
  let braveSocials: SocialsResult;
  let braveSocialCandidates: Record<string, string[]>;
  let confidenceThreshold: number;
  let learningContext: string;

  try {
    const [threshold, learning, enabledPlatforms] = await Promise.all([
      fetchConfidenceThreshold(),
      buildLearningContext(),
      fetchEnabledPlatforms(),
    ]);
    confidenceThreshold = threshold;
    learningContext = learning;

    // Brave socials cached 24h — platform list affects results so include it in key
    const socialsResult = await withBraveCache(
      `ps_socials|${personName.toLowerCase()}|${enabledPlatforms.join(',')}`,
      () => searchBravePersonSocials(braveKey, personName, enabledPlatforms)
    );
    braveSocials = socialsResult.socials;
    braveSocialCandidates = socialsResult.allCandidates;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Brave Search fejl';
    return NextResponse.json({ error: `Søgning fejlede: ${msg}` }, { status: 502 });
  }

  // ── Byg Claude-besked ──
  const personContext = [
    `Personens fulde navn: ${personName}`,
    city ? `By: ${city}` : null,
    companies.length > 0
      ? `Virksomheder: ${companies
          .slice(0, 3)
          .map((c) => c.name)
          .join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const locationHint = city ? ` i ${city}` : ' i Danmark';
  const candidatesStr =
    Object.keys(braveSocialCandidates).length > 0
      ? Object.entries(braveSocialCandidates)
          .map(([platform, urls]) =>
            urls.length === 1
              ? `- ${platform}: ${urls[0]}`
              : `- ${platform}:\n${urls.map((u, i) => `    ${i + 1}. ${u}`).join('\n')}`
          )
          .join('\n')
      : '(Ingen sociale medie-profiler fundet)';

  const userMessage =
    `Person:\n${personContext}\n\nBrave Search har fundet disse sociale medie-profil-kandidater — verificer om de tilhører NETOP DENNE PERSON${locationHint}:\n${candidatesStr}\n\n` +
    `Vælg den bedste URL per platform med passende confidence-score. Udelad platforme der ikke tilhører denne person.`;

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

    // Brave-fallback: hvis Claude ikke verificerede en platform, vis Brave-fund med confidence=65
    for (const [platform, url] of Object.entries(braveSocials)) {
      if (url && !socialsWithMeta[platform]) {
        socialsWithMeta[platform] = {
          url,
          confidence: 65,
          reason: 'Fundet via Brave Search (ikke verificeret af AI)',
        };
      }
    }

    const socials: SocialsResult = { ...braveSocials, ...claudeSocials };

    logger.log(
      `[person-search/socials] "${personName}": primære=[${Object.keys(socialsWithMeta).join(',')}], tokens=${totalTokens}`
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
