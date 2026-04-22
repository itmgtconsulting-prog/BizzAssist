/**
 * GET /api/search?q=<query>
 *
 * Unified search API that searches across addresses (DAR), companies (cvrapi.dk),
 * and people (placeholder) in parallel. Results are scored with fuzzy matching
 * (Levenshtein distance), normalized for diacritics and case, and returned in a
 * unified shape sorted by relevance.
 *
 * @param request - Next.js request with ?q= search string
 * @returns Array of UnifiedSearchResult sorted by score descending (max 8)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { darAutocomplete } from '@/app/lib/dar';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

/** BIZZ-210: Zod schema for search query params */
const searchParamsSchema = z.object({
  q: z.string().trim().min(2).max(500),
});

// ─── Types ───────────────────────────────────────────────────────────────────

/** Unified search result returned by this endpoint. */
export interface UnifiedSearchResult {
  /** Data type */
  type: 'address' | 'company' | 'person';
  /** Unique identifier: DAWA UUID, CVR number, or person ID */
  id: string;
  /** Primary display text */
  title: string;
  /** Secondary info line (postnr+by, industry, etc.) */
  subtitle: string;
  /** Fuzzy match relevance score (0-100) */
  score: number;
  /** Client-side navigation URL */
  href: string;
  /** Optional extra data */
  meta?: Record<string, string>;
}

// ─── Fuzzy matching utilities ────────────────────────────────────────────────

/**
 * Normalize a string for comparison: lowercase, trim, replace Danish diacritics
 * with ASCII equivalents (ae, oe, aa).
 *
 * @param s - Input string
 * @returns Normalized string
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\u00e6/g, 'ae') // ae
    .replace(/\u00f8/g, 'oe') // oe
    .replace(/\u00e5/g, 'aa') // aa
    .replace(/\u00c6/g, 'ae') // AE
    .replace(/\u00d8/g, 'oe') // OE
    .replace(/\u00c5/g, 'aa'); // AA
}

/**
 * Compute the Levenshtein edit distance between two strings.
 * Uses the classic dynamic-programming approach with O(min(a,b)) space.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Edit distance (integer >= 0)
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is shorter for memory efficiency
  if (a.length > b.length) [a, b] = [b, a];

  const aLen = a.length;
  const bLen = b.length;
  let prev = Array.from({ length: aLen + 1 }, (_, i) => i);
  let curr = new Array<number>(aLen + 1);

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1, // deletion
        curr[i - 1] + 1, // insertion
        prev[i - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[aLen];
}

/**
 * Score a result text against the query using multiple matching strategies.
 * Higher score = better match.
 *
 * Scoring:
 * - Exact match: 100
 * - Starts with query: 80
 * - Contains query: 60
 * - Any word starts with query: 50
 * - Levenshtein distance <= 2 (on full string or any word): 40
 * - No match: 0
 *
 * @param query - Normalized search query
 * @param text - Normalized result text
 * @returns Score 0-100
 */
function scoreMatch(query: string, text: string): number {
  if (!query || !text) return 0;

  // Exact match
  if (text === query) return 100;

  // Starts with
  if (text.startsWith(query)) return 80;

  // Contains
  if (text.includes(query)) return 60;

  // Any word starts with query
  const words = text.split(/\s+/);
  if (words.some((w) => w.startsWith(query))) return 50;

  // Fuzzy: Levenshtein on full text (only if lengths are comparable)
  if (Math.abs(text.length - query.length) <= 3 && levenshtein(query, text) <= 2) return 40;

  // Fuzzy: Levenshtein on individual words
  if (words.some((w) => Math.abs(w.length - query.length) <= 3 && levenshtein(query, w) <= 2)) {
    return 40;
  }

  // Multi-word query: check each query word against text words
  const queryWords = query.split(/\s+/);
  if (queryWords.length > 1) {
    const matchCount = queryWords.filter((qw) =>
      words.some(
        (tw) =>
          tw.startsWith(qw) || (Math.abs(tw.length - qw.length) <= 3 && levenshtein(qw, tw) <= 2)
      )
    ).length;
    if (matchCount === queryWords.length) return 70;
    if (matchCount > 0) return 30 + (matchCount / queryWords.length) * 30;
  }

  return 0;
}

// ─── Source search functions ─────────────────────────────────────────────────

/**
 * Search addresses via DAR autocomplete and map to unified results.
 *
 * @param q - Raw query string
 * @param normQ - Normalized query for scoring
 * @returns Array of UnifiedSearchResult (type='address')
 */
async function searchAddresses(q: string, normQ: string): Promise<UnifiedSearchResult[]> {
  try {
    const results = await darAutocomplete(q);

    // BIZZ-723: DAR_Adresse indekserer ikke alltid alle ejerlejligheder under
    // en given adgangsadresse (asymmetrisk data — 62B's lejligheder vises, 62A's
    // ikke). For hver matched adgangsadresse probe DAWA /adresser for under-
    // liggende enheder og tilføj dem hvis de har etage/dør og ikke allerede er
    // i resultatsættet. Max 3 parallelle probes for at holde p95 under 500ms.
    const adgangsadresser = results.filter((r) => r.type === 'adgangsadresse').slice(0, 3);
    const existingAdresseIds = new Set(
      results.filter((r) => r.type === 'adresse').map((r) => r.adresse.id)
    );
    const extraAdresseResults: Array<{
      type: 'adresse';
      tekst: string;
      adresse: {
        id: string;
        vejnavn: string;
        husnr: string;
        etage?: string;
        dør?: string;
        postnr: string;
        postnrnavn: string;
        kommunenavn: string;
        x: number;
        y: number;
      };
    }> = [];
    if (adgangsadresser.length > 0) {
      try {
        const probeResults = await Promise.all(
          adgangsadresser.map(async (adg) => {
            try {
              // BIZZ-723 v2: Use plain fetch without next: { revalidate } — that
              // option combined with AbortSignal seemed to cause silent failures
              // in the Vercel runtime for this specific call. DAWA responses are
              // small and this only fires once per search, so un-cached is fine.
              const probeRes = await fetch(
                `${DAWA_BASE_URL}/adresser?adgangsadresseid=${encodeURIComponent(adg.adresse.id)}&struktur=mini&per_side=10`,
                { signal: AbortSignal.timeout(3000) }
              );
              if (!probeRes.ok) return [];
              return (await probeRes.json()) as Array<{
                id?: string;
                etage?: string;
                dør?: string;
                betegnelse?: string;
                adressebetegnelse?: string;
              }>;
            } catch (err) {
              logger.warn(
                `[search/723] probe fetch failed for adg ${adg.adresse.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`
              );
              return [];
            }
          })
        );
        for (let i = 0; i < adgangsadresser.length; i++) {
          const adg = adgangsadresser[i];
          const units = probeResults[i];
          for (const u of units) {
            // Skip units without etage/dør — they're the same as adgangsadresse.
            if (!u.id || !(u.etage || u.dør)) continue;
            if (existingAdresseIds.has(u.id)) continue;
            existingAdresseIds.add(u.id);
            const betegnelse = u.betegnelse ?? u.adressebetegnelse ?? '';
            extraAdresseResults.push({
              type: 'adresse',
              tekst:
                betegnelse ||
                `${adg.adresse.vejnavn} ${adg.adresse.husnr}${u.etage ? `, ${u.etage}.` : ''}${u.dør ? ` ${u.dør}` : ''}`,
              adresse: {
                id: u.id,
                vejnavn: adg.adresse.vejnavn,
                husnr: adg.adresse.husnr,
                etage: u.etage,
                dør: u.dør,
                postnr: adg.adresse.postnr,
                postnrnavn: adg.adresse.postnrnavn,
                kommunenavn: adg.adresse.kommunenavn,
                x: 0,
                y: 0,
              },
            });
          }
        }
      } catch (err) {
        logger.warn('[search] Adgangsadresse unit-probe fejlede:', err);
      }
    }

    // Merge extras into results — cap at 12 so the dropdown doesn't overflow
    // (was 8). Hovedejendomme + alle under-adresser + andre ejerlejligheder.
    const merged = [...results, ...extraAdresseResults];
    const mapped = merged.slice(0, 12).map((r) => {
      const normText = normalize(r.tekst);
      // BIZZ-608: Distinguish mellem hovedejendom (adgangsadresse) og
      // ejerlejlighed (adresse med etage/dør) i subtitle så brugeren
      // ved hvilken type ejendom de er ved at åbne.
      let subtitle: string;
      if (r.type === 'vejnavn') {
        subtitle = 'Vej';
      } else if (r.type === 'adresse') {
        // Ejerlejlighed — "Lejlighed · 1234 By" eller med etage/dør
        const etageDoer = [r.adresse.etage, r.adresse.dør].filter(Boolean).join('. ');
        const stedInfo = `${r.adresse.postnr} ${r.adresse.postnrnavn}`.trim();
        subtitle = etageDoer ? `Lejlighed · ${etageDoer} · ${stedInfo}` : `Lejlighed · ${stedInfo}`;
      } else {
        // Adgangsadresse — hovedejendom eller normal ejendom
        subtitle = `${r.adresse.postnr} ${r.adresse.postnrnavn}`.trim();
      }
      return {
        type: 'address' as const,
        id: r.adresse.id,
        title: r.tekst,
        subtitle,
        score: Math.max(scoreMatch(normQ, normText), 50), // addresses from DAR are always relevant
        href: `/dashboard/ejendomme/${r.adresse.id}`,
        meta: {
          dawaType: r.type,
          vejnavn: r.adresse.vejnavn,
          husnr: r.adresse.husnr || '',
          etage: r.adresse.etage ?? '',
          dør: r.adresse.dør ?? '',
          postnr: r.adresse.postnr,
          postnrnavn: r.adresse.postnrnavn,
          kommunenavn: r.adresse.kommunenavn,
        },
      };
    });
    return mapped;
  } catch (err) {
    logger.error('[search] Address search failed:', err);
    return [];
  }
}

/**
 * Fetch a single company via the internal /api/cvr-public proxy.
 * The proxy handles SSL/TLS to cvrapi.dk server-side, avoiding Windows
 * schannel certificate revocation issues on the dev machine.
 * Supports both vat= and name= lookups.
 *
 * @param param - "name=Novo" or "vat=12345678"
 * @param baseUrl - Base URL for internal API calls (e.g. http://localhost:3000)
 * @returns Raw company object or null
 */
async function fetchCvrApi(
  param: string,
  baseUrl: string,
  cookieHeader: string = ''
): Promise<Record<string, unknown> | null> {
  try {
    // All requests go through internal proxy — handles SSL + caching
    const res = await fetch(`${baseUrl}/api/cvr-public?${param}`, {
      signal: AbortSignal.timeout(10000),
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    if (!res.ok) return null;
    const raw: Record<string, unknown> = await res.json();
    if (raw.error || !raw.vat) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Map a raw cvrapi.dk response to a UnifiedSearchResult.
 *
 * @param raw - Raw company object from cvrapi.dk
 * @param normQ - Normalized query for scoring
 * @param isVat - Whether the search was by CVR number
 * @returns UnifiedSearchResult or null if not relevant
 */
function mapCompanyResult(
  raw: Record<string, unknown>,
  normQ: string,
  isVat: boolean
): UnifiedSearchResult | null {
  const vat = typeof raw.vat === 'number' ? raw.vat : 0;
  const name = String(raw.name ?? '');
  if (!vat || !name) return null;

  const industrydesc = raw.industrydesc ? String(raw.industrydesc) : '';
  const city = raw.city ? String(raw.city) : '';
  const zipcode = raw.zipcode ? String(raw.zipcode) : '';
  const normName = normalize(name);
  const score = isVat ? 90 : scoreMatch(normQ, normName);

  if (score <= 0 && !isVat) return null;

  return {
    type: 'company' as const,
    id: String(vat),
    title: name,
    subtitle: [industrydesc, zipcode && city ? `${zipcode} ${city}` : '']
      .filter(Boolean)
      .join(' \u00b7 '),
    score: Math.max(score, 40),
    href: `/dashboard/companies/${vat}`,
    meta: {
      cvr: String(vat),
      ...(industrydesc ? { industry: industrydesc } : {}),
      ...(city ? { city } : {}),
    },
  };
}

/**
 * Search companies via /api/cvr-search (CVR ElasticSearch multi-result).
 * Falls back to cvrapi.dk for CVR number lookups.
 *
 * @param q - Raw query string
 * @param normQ - Normalized query for scoring
 * @param baseUrl - Base URL for internal API calls
 * @returns Array of UnifiedSearchResult (type='company'), max 5
 */
async function searchCompanies(
  q: string,
  normQ: string,
  baseUrl: string,
  cookieHeader: string = ''
): Promise<UnifiedSearchResult[]> {
  try {
    const trimmed = q.trim();
    const isVat = /^\d{8}$/.test(trimmed);

    if (isVat) {
      const raw = await fetchCvrApi(`vat=${trimmed}`, baseUrl, cookieHeader);
      if (!raw) return [];
      const result = mapCompanyResult(raw, normQ, true);
      return result ? [result] : [];
    }

    // Use /api/cvr-search for multi-result company search
    const res = await fetch(`${baseUrl}/api/cvr-search?q=${encodeURIComponent(trimmed)}`, {
      signal: AbortSignal.timeout(6000),
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      results?: {
        cvr: number;
        name: string;
        address: string | null;
        zipcode: string | null;
        city: string | null;
        industry: string | null;
        companyType: string | null;
        active: boolean;
      }[];
    };
    const hits = data.results ?? [];

    return hits.slice(0, 5).map((h) => {
      const normName = normalize(h.name);
      const score = scoreMatch(normQ, normName);
      return {
        type: 'company' as const,
        id: String(h.cvr),
        title: h.name,
        subtitle: [h.industry, h.zipcode && h.city ? `${h.zipcode} ${h.city}` : '']
          .filter(Boolean)
          .join(' \u00b7 '),
        score: Math.max(score, 40),
        href: `/dashboard/companies/${h.cvr}`,
        meta: {
          cvr: String(h.cvr),
          active: h.active ? 'true' : 'false',
          ...(h.industry ? { industry: h.industry } : {}),
          ...(h.city ? { city: h.city } : {}),
        },
      };
    });
  } catch (err) {
    logger.error('[search] Company search failed:', err);
    return [];
  }
}

/**
 * Search people via /api/person-search (CVR ES deltager index).
 *
 * @param q - Raw query string
 * @param normQ - Normalized query for scoring
 * @param baseUrl - Base URL for internal API calls
 * @returns Array of UnifiedSearchResult (type='person'), max 5
 */
async function searchPeople(
  q: string,
  normQ: string,
  baseUrl: string,
  cookieHeader: string = ''
): Promise<UnifiedSearchResult[]> {
  try {
    const res = await fetch(`${baseUrl}/api/person-search?q=${encodeURIComponent(q.trim())}`, {
      signal: AbortSignal.timeout(6000),
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      results?: {
        enhedsNummer: number;
        name: string;
        erVirksomhed: boolean;
        antalVirksomheder: number;
        roller?: { virksomhedNavn: string; rolle: string | null }[];
      }[];
    };
    const hits = data.results ?? [];

    return hits.slice(0, 5).map((h) => {
      const normName = normalize(h.name);
      const score = scoreMatch(normQ, normName);
      const rolleText =
        h.roller && h.roller.length > 0
          ? h.roller
              .slice(0, 2)
              .map((r) => (r.rolle ? `${r.rolle}, ${r.virksomhedNavn}` : r.virksomhedNavn))
              .join(' · ')
          : h.antalVirksomheder > 0
            ? `${h.antalVirksomheder} virksomheder`
            : '';
      return {
        type: 'person' as const,
        id: String(h.enhedsNummer),
        title: h.name,
        subtitle: rolleText,
        score: Math.max(score, 35),
        href: `/dashboard/owners/${h.enhedsNummer}`,
        meta: {
          enhedsNummer: String(h.enhedsNummer),
          erVirksomhed: h.erVirksomhed ? 'true' : 'false',
        },
      };
    });
  } catch (err) {
    logger.error('[search] People search failed:', err);
    return [];
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // Rate limit: 60 req/min (standard)
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // BIZZ-210: Zod schema validation for query params
  const parsed = parseQuery(request, searchParamsSchema);
  if (!parsed.success) {
    return NextResponse.json([], {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }
  const q = parsed.data.q;

  const normQ = normalize(q);

  // Derive base URL for internal API calls (works on localhost + Vercel)
  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  // BIZZ-318: Forward caller's cookies so internal API calls are authenticated
  const cookieHeader = request.headers.get('cookie') ?? '';

  // Run all searches in parallel — each handles its own errors
  const [addresses, companies, people] = await Promise.all([
    searchAddresses(q, normQ),
    searchCompanies(q, normQ, baseUrl, cookieHeader),
    searchPeople(q, normQ, baseUrl, cookieHeader),
  ]);

  // Group by type — max 10 addresses (BIZZ-723: hovedejendom + lejligheder på
  // samme matrikel kan let overstige 5), 5 companies, 5 people. Sorted by score.
  const addrResults = addresses.slice(0, 10).sort((a, b) => b.score - a.score);
  const compResults = companies.slice(0, 5).sort((a, b) => b.score - a.score);
  const pplResults = people.slice(0, 5).sort((a, b) => b.score - a.score);

  // Grouped output: addresses → companies → people (not mixed)
  const results: UnifiedSearchResult[] = [...addrResults, ...compResults, ...pplResults];

  return NextResponse.json(results, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
  });
}
