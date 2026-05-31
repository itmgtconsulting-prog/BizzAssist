/**
 * POST /api/virksomhedshandler/berig
 *
 * BIZZ-1928: AI-beriget virksomhedshandel-kandidat.
 * Beregner estimeret salgsværdi (interval) via branche-multiple,
 * søger medie-links via Brave Search, og returnerer confidence-level.
 *
 * @param body.kandidat_id        - Unik ID for kandidat-rækken
 * @param body.virksomhed_cvr     - CVR-nummer på target-virksomheden
 * @param body.person_enhedsnummer - Enhedsnummer for deltager (valgfrit)
 * @param body.deltager_navn      - Navn på deltager (valgfrit, til mediesøgning)
 * @param body.virksomhed_navn    - Virksomhedsnavn (valgfrit, til mediesøgning)
 * @param body.ejerandel_delta_pp - Ændring i ejerandel i procentpoint
 * @param body.aarsresultat_dkk   - Seneste årsresultat (EBITDA proxy) i DKK
 * @param body.branchekode        - DB07 branchekode
 * @param body.gyldig_fra         - Gyldig-fra dato for ejerskiftet (valgfrit, til medie-tidsfilter)
 * @returns Estimeret værdi, medie-links, confidence
 *
 * @module app/api/virksomhedshandler/berig/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { logger } from '@/app/lib/logger';
import { estimerVaerdi } from '@/app/lib/virksomhedshandler/brancheMultiples';
import { BRAVE_SEARCH_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { recordAiUsage } from '@/app/lib/aiTracking';

export const runtime = 'nodejs';
export const maxDuration = 30;

// ─── Types ──────────────────────────────────────────────────────────────────

interface BerigRequest {
  kandidat_id: string;
  virksomhed_cvr: string;
  person_enhedsnummer?: number;
  deltager_navn?: string;
  virksomhed_navn?: string;
  ejerandel_delta_pp: number;
  aarsresultat_dkk: number;
  branchekode: string;
  gyldig_fra?: string;
}

interface MediaLink {
  title: string;
  url: string;
  publisher: string;
  published_at: string;
  relevance_score: number;
}

interface BerigResponse {
  estimeret_vaerdi: { lav: number; mid: number; hoej: number; currency: 'DKK' } | null;
  formel_forklaring: string;
  medie_links: MediaLink[];
  confidence: 'low' | 'medium' | 'high';
  confidence_reason: string;
}

// ─── Cache (24h TTL) ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { data: BerigResponse; ts: number }>();

/**
 * Renser expired entries fra cache.
 * Kaldes periodisk for at undgå memory leak.
 */
function pruneCache(): void {
  const now = Date.now();
  const keys = Array.from(cache.keys());
  for (let i = 0; i < keys.length; i++) {
    const entry = cache.get(keys[i]);
    if (entry && now - entry.ts > CACHE_TTL_MS) cache.delete(keys[i]);
  }
}

// ─── Brave Search helper ────────────────────────────────────────────────────

/**
 * Søger Brave for medie-dækning af en virksomhedshandel.
 *
 * @param query - Søgeforespørgsel
 * @param gyldigFra - Dato for ejerskiftet (brugt til tidsfilter)
 */
async function searchMedia(query: string, gyldigFra?: string): Promise<MediaLink[]> {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) return [];

  const params = new URLSearchParams({
    q: query,
    count: '10',
    country: 'dk',
  });

  // Tilføj freshness-filter: ±3 måneder omkring gyldig_fra
  if (gyldigFra) {
    const date = new Date(gyldigFra);
    if (!isNaN(date.getTime())) {
      const from = new Date(date);
      from.setMonth(from.getMonth() - 3);
      const to = new Date(date);
      to.setMonth(to.getMonth() + 3);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      params.set('freshness', `${fmt(from)}to${fmt(to)}`);
    }
  }

  const url = `${BRAVE_SEARCH_ENDPOINT}?${params}`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': braveKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return [];

  const data = await res.json();
  const results: Array<{
    title: string;
    url: string;
    description?: string;
    age?: string;
    meta_url?: { hostname?: string };
  }> = data.web?.results ?? [];

  const seen = new Set<string>();
  return results
    .filter((r) => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .map((r, i) => ({
      title: r.title?.trim() ?? '',
      url: r.url?.trim() ?? '',
      publisher: r.meta_url?.hostname?.replace(/^www\./, '').trim() ?? '',
      published_at: r.age?.trim() ?? '',
      relevance_score: Math.max(0, 1 - i * 0.1),
    }))
    .filter((r) => r.title && r.url)
    .slice(0, 5);
}

// ─── Confidence scoring ─────────────────────────────────────────────────────

/**
 * Beregner confidence-niveau baseret på data-tilgængelighed.
 *
 * @param mediaLinks - Fundne medie-links
 * @param deltaPercent - Ejerandel-ændring i procentpoint
 * @param hasValuation - Om en værdiansættelse kunne beregnes
 */
function scoreConfidence(
  mediaLinks: MediaLink[],
  deltaPercent: number,
  hasValuation: boolean
): { confidence: 'low' | 'medium' | 'high'; reason: string } {
  if (mediaLinks.length > 0 && deltaPercent > 25) {
    return { confidence: 'high', reason: 'Medie-dækning fundet + stor ejerandelsændring (>25 pp)' };
  }
  if (mediaLinks.length > 0 && deltaPercent > 5) {
    return {
      confidence: 'medium',
      reason: 'Medie-dækning fundet + moderat ejerandelsændring (>5 pp)',
    };
  }
  if (deltaPercent > 25 && hasValuation) {
    return {
      confidence: 'medium',
      reason: 'Stor ejerandelsændring (>25 pp) med branche-multiple tilgængelig',
    };
  }
  if (deltaPercent > 5) {
    return { confidence: 'low', reason: 'Moderat ejerandelsændring, ingen medie-dækning fundet' };
  }
  return { confidence: 'low', reason: 'Lille ejerandelsændring (<5 pp), ingen stærke signaler' };
}

// ─── POST handler ───────────────────────────────────────────────────────────

/**
 * POST /api/virksomhedshandler/berig
 *
 * Beriger en virksomhedshandel-kandidat med værdiansættelse og medie-links.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Rate limit
  const limited = await checkRateLimit(req, aiRateLimit);
  if (limited) return limited;

  // Auth
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
  }

  // AI billing gate
  const gateResponse = await assertAiAllowed(auth.userId);
  if (gateResponse) return gateResponse as unknown as NextResponse;

  // Parse body
  let body: BerigRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { kandidat_id, virksomhed_cvr, ejerandel_delta_pp, aarsresultat_dkk, branchekode } = body;

  if (
    !kandidat_id ||
    !virksomhed_cvr ||
    ejerandel_delta_pp == null ||
    aarsresultat_dkk == null ||
    !branchekode
  ) {
    return NextResponse.json(
      {
        error:
          'Manglende felter: kandidat_id, virksomhed_cvr, ejerandel_delta_pp, aarsresultat_dkk, branchekode',
      },
      { status: 400 }
    );
  }

  // Check cache (24h TTL)
  pruneCache();
  const cacheKey = `berig:${kandidat_id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  try {
    // 1. Estimér værdi via branche-multiple
    const vaerdi = estimerVaerdi(branchekode, aarsresultat_dkk, ejerandel_delta_pp);

    // 2. Søg medie-links
    const searchParts: string[] = [];
    if (body.deltager_navn) searchParts.push(body.deltager_navn);
    if (body.virksomhed_navn) searchParts.push(body.virksomhed_navn);
    if (searchParts.length === 0) searchParts.push(virksomhed_cvr);
    searchParts.push('salg exit handel');

    const mediaLinks = await searchMedia(searchParts.join(' '), body.gyldig_fra);

    // 3. Confidence scoring
    const { confidence, reason } = scoreConfidence(mediaLinks, ejerandel_delta_pp, vaerdi !== null);

    // 4. Byg response
    const response: BerigResponse = {
      estimeret_vaerdi: vaerdi
        ? { lav: vaerdi.low, mid: vaerdi.mid, hoej: vaerdi.high, currency: 'DKK' }
        : null,
      formel_forklaring: `andel_delta (${ejerandel_delta_pp}%) × årsresultat (${aarsresultat_dkk.toLocaleString('da-DK')} DKK) × branche_multiple`,
      medie_links: mediaLinks,
      confidence,
      confidence_reason: reason,
    };

    // 5. Cache result
    cache.set(cacheKey, { data: response, ts: Date.now() });

    // 6. Record AI usage (fire-and-forget — Brave tokens minimal)
    void recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'virksomhedshandler.berig',
      inputTokens: 0,
      outputTokens: 0,
      model: 'brave-search',
    });

    return NextResponse.json(response);
  } catch (err) {
    logger.error('virksomhedshandler/berig fejl', { error: err });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
