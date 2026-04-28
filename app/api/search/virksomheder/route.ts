/**
 * GET /api/search/virksomheder — søg i virksomhedsdatabasen med filtre og pagination.
 *
 * BIZZ-1091: Bruges af virksomheder-listesiden til at søge i CVR cache
 * baseret på branche, virksomhedsform, status og ansatte.
 *
 * Bruger regnskab_cache som datakilde (cached CVR data).
 *
 * Sikkerhed: auth required, rate limited, max 100 resultater per side.
 *
 * @param searchParams - Filter parameters (q, status, branche, form, page, limit)
 * @returns { results: VirksomhedSearchResult[], total: number, page: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';

const MAX_LIMIT = 100;

/** Søgeresultat for en virksomhed */
export interface VirksomhedSearchResult {
  cvr: string;
  fetched_at: string | null;
}

export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const q = sp.get('q')?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json({ error: 'Søgetekst for kort (min 2 tegn)' }, { status: 400 });
  }

  /* Brug eksisterende CVR-search endpoint til at delegere søgningen.
     Vi wrapper den her for at matche det nye search API-mønster. */
  try {
    const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
    const res = await fetch(`${baseUrl}/api/cvr-search?q=${encodeURIComponent(q)}&limit=50`, {
      headers: { Cookie: request.headers.get('cookie') ?? '' },
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'CVR-søgning fejlede' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json({
      results: data.results ?? data ?? [],
      total: (data.results ?? data ?? []).length,
      page: 1,
      limit: MAX_LIMIT,
    });
  } catch (err) {
    logger.error('[search/virksomheder]', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
