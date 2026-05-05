/**
 * GET /api/public/search — offentlig virksomhedssøgning (INGEN auth).
 *
 * BIZZ-1097/1100: Bruges af forsiden søgefelt til at søge i cvr_virksomhed
 * cache-tabellen uden login. Hårdt rate limited (10 req/min per IP).
 *
 * @param q - Søgetekst (min 3 tegn, eller 8-cifret CVR-nummer)
 * @param limit - Max resultater (default 5, max 10)
 * @returns Array af { cvr, name, city }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** Simple IP-baseret in-memory rate limiter (10 req/min) */
const ipHits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const WINDOW_MS = 60_000;

/**
 * Tjek rate limit for en IP-adresse.
 *
 * @param ip - Klient-IP
 * @returns true hvis rate limited
 */
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now > entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

/** Søgeresultat */
export interface PublicSearchResult {
  cvr: string;
  name: string;
  city: string | null;
}

export async function GET(request: NextRequest) {
  // Rate limit per IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const sp = request.nextUrl.searchParams;
  const q = sp.get('q')?.trim();
  const limit = Math.min(10, Math.max(1, Number(sp.get('limit') ?? 5)));

  if (!q || q.length < 3) {
    return NextResponse.json({ error: 'Søgetekst for kort (min 3 tegn)' }, { status: 400 });
  }

  try {
    const admin = createAdminClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (admin as any).from('cvr_virksomhed').select('cvr, navn, adresse_json');

    // CVR-nummer match (8 cifre)
    if (/^\d{8}$/.test(q)) {
      query = query.eq('cvr', q);
    } else {
      // Dansk full-text search
      query = query.textSearch('navn', q, { type: 'websearch', config: 'danish' });
    }

    query = query.is('ophoert', null).limit(limit);

    const { data, error } = await query;

    if (error) {
      logger.error('[public/search]', error.message);
      return NextResponse.json({ error: 'Databasefejl' }, { status: 500 });
    }

    const results: PublicSearchResult[] = (data ?? []).map(
      (r: { cvr: string; navn: string; adresse_json: Record<string, string> | null }) => ({
        cvr: r.cvr,
        name: r.navn,
        city: r.adresse_json?.postdistrikt ?? r.adresse_json?.bynavn ?? null,
      })
    );

    return NextResponse.json(
      { results },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      }
    );
  } catch (err) {
    logger.error('[public/search] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
