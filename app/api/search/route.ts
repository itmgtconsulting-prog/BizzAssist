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
import { darAutocomplete } from '@/app/lib/dar';

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
    return results.slice(0, 5).map((r) => {
      const normText = normalize(r.tekst);
      return {
        type: 'address' as const,
        id: r.adresse.id,
        title: r.tekst,
        subtitle: r.type === 'vejnavn' ? 'Vej' : `${r.adresse.postnr} ${r.adresse.postnrnavn}`,
        score: Math.max(scoreMatch(normQ, normText), 50), // addresses from DAR are always relevant
        href: `/dashboard/ejendomme/${r.adresse.id}`,
        meta: {
          dawaType: r.type,
          vejnavn: r.adresse.vejnavn,
          husnr: r.adresse.husnr || '',
          postnr: r.adresse.postnr,
          postnrnavn: r.adresse.postnrnavn,
          kommunenavn: r.adresse.kommunenavn,
        },
      };
    });
  } catch (err) {
    console.error('[search] Address search failed:', err);
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
  baseUrl: string
): Promise<Record<string, unknown> | null> {
  try {
    // All requests go through internal proxy — handles SSL + caching
    const res = await fetch(`${baseUrl}/api/cvr-public?${param}`, {
      signal: AbortSignal.timeout(5000),
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
 * Search companies via cvrapi.dk (through internal proxy). Since cvrapi.dk returns
 * only 1 result per query, we run multiple parallel searches with variations of the
 * query to gather up to 5 results.
 *
 * Strategies:
 * - Direct name search with full query
 * - Individual word searches (for multi-word queries)
 * - Name + common suffixes (A/S, ApS, I/S)
 *
 * @param q - Raw query string
 * @param normQ - Normalized query for scoring
 * @param baseUrl - Base URL for internal API calls
 * @returns Array of UnifiedSearchResult (type='company'), max 5
 */
async function searchCompanies(
  q: string,
  normQ: string,
  baseUrl: string
): Promise<UnifiedSearchResult[]> {
  try {
    const trimmed = q.trim();
    const isVat = /^\d{8}$/.test(trimmed);

    if (isVat) {
      const raw = await fetchCvrApi(`vat=${trimmed}`, baseUrl);
      if (!raw) return [];
      const result = mapCompanyResult(raw, normQ, true);
      return result ? [result] : [];
    }

    // Build search variations to get multiple results from cvrapi.dk
    const variations = new Set<string>();
    variations.add(trimmed);

    // Add individual words (3+ chars) for multi-word queries
    const words = trimmed.split(/\s+/).filter((w) => w.length >= 3);
    for (const w of words) variations.add(w);

    // Add common company suffixes
    const suffixes = ['A/S', 'ApS', 'I/S', 'Holding'];
    for (const suffix of suffixes) {
      if (!trimmed.toLowerCase().includes(suffix.toLowerCase())) {
        variations.add(`${trimmed} ${suffix}`);
      }
    }

    // Run up to 8 parallel searches for more result diversity (deduplicate by CVR)
    const searchTerms = [...variations].slice(0, 8);
    const rawResults = await Promise.all(
      searchTerms.map((term) => fetchCvrApi(`name=${encodeURIComponent(term)}`, baseUrl))
    );

    // Deduplicate by CVR and map to results
    const seen = new Set<number>();
    const results: UnifiedSearchResult[] = [];
    for (const raw of rawResults) {
      if (!raw) continue;
      const vat = typeof raw.vat === 'number' ? raw.vat : 0;
      if (seen.has(vat)) continue;
      seen.add(vat);
      const result = mapCompanyResult(raw, normQ, false);
      if (result) results.push(result);
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 5);
  } catch (err) {
    console.error('[search] Company search failed:', err);
    return [];
  }
}

/**
 * Search people. Currently returns empty array (no API available).
 *
 * @param _q - Raw query string (unused)
 * @param _normQ - Normalized query (unused)
 * @returns Empty array
 */
async function searchPeople(_q: string, _normQ: string): Promise<UnifiedSearchResult[]> {
  // No people API available yet — placeholder for future integration
  return [];
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q') ?? '';

  if (q.trim().length < 2) {
    return NextResponse.json([], {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  const normQ = normalize(q);

  // Derive base URL for internal API calls (works on localhost + Vercel)
  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;

  // Run all searches in parallel — each handles its own errors
  const [addresses, companies, people] = await Promise.all([
    searchAddresses(q, normQ),
    searchCompanies(q, normQ, baseUrl),
    searchPeople(q, normQ),
  ]);

  // Group by type — max 5 per category, sorted by score within each group
  // Then interleave: addresses first, then companies, then people (each sorted by score)
  const addrResults = addresses.slice(0, 5).sort((a, b) => b.score - a.score);
  const compResults = companies.slice(0, 5).sort((a, b) => b.score - a.score);
  const pplResults = people.slice(0, 5).sort((a, b) => b.score - a.score);

  // Grouped output: addresses → companies → people (not mixed)
  const results: UnifiedSearchResult[] = [...addrResults, ...compResults, ...pplResults];

  return NextResponse.json(results, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
  });
}
