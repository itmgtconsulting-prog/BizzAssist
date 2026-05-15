/**
 * GET /api/tinglysning/historisk-adkomster?bfe=XXXXX
 *
 * BIZZ-1494 (Trin 2): Henter fuld historisk adkomst-historik fra
 * Tinglysning XML API. Returnerer alle historiske handler med
 * købesummer og adkomsthavere.
 *
 * Rate-limited (heavyRateLimit) da XML API kræver mTLS og er dyrt.
 * Returnerer 502 med generisk fejl ved API-failure.
 *
 * @param bfe - BFE-nummer
 * @returns Array af historiske adkomster med priser
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { fetchHistoriskAdkomsterByBfe } from '@/app/lib/tinglysningHistoriskAdkomster';

export const runtime = 'nodejs';
export const maxDuration = 90;

/**
 * GET handler.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limited = await checkRateLimit(request, heavyRateLimit);
  if (limited) return limited;

  const bfe = Number(request.nextUrl.searchParams.get('bfe'));
  if (!Number.isFinite(bfe) || bfe <= 0) {
    return NextResponse.json({ error: 'Ugyldigt BFE-nummer' }, { status: 400 });
  }

  try {
    const rows = await fetchHistoriskAdkomsterByBfe(bfe);

    // Maskér CPR i response (sikkerhed)
    const sanitized = rows.map((r) => ({
      ...r,
      adkomsthavere: r.adkomsthavere.map((a) => ({
        ...a,
        cpr: a.cpr ? 'XXXXXX-XXXX' : null,
      })),
      rawText: undefined,
    }));

    return NextResponse.json(
      { bfe, historik: sanitized, count: sanitized.length },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' } }
    );
  } catch (err) {
    logger.error('[historisk-adkomster] Fejl:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
