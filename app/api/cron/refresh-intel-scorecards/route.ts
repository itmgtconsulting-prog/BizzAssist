/**
 * Cron: Intel Scorecard Refresh — /api/cron/refresh-intel-scorecards
 *
 * BIZZ-1565 (L3): Natlig opdatering af public.intel_scorecard. Kalder den
 * SECURITY DEFINER PL/pgSQL-funktion refresh_intel_scorecards() der
 * opdaterer alle ~25 keys i én transaktion.
 *
 * Schedule: 0 4 * * * UTC (dagligt 04:00 — efter refresh-data-catalog 03:00
 * og refresh-materialized-views 05:00).
 *
 * Manuel trigger: GET med Authorization: Bearer $CRON_SECRET
 *
 * @module api/cron/refresh-intel-scorecards
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { createDefaultSqlRunner } from '@/app/lib/dataIntelligence/buildCatalog';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Verificér CRON_SECRET + (i prod) Vercel cron-header. */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/**
 * GET handler — kører scorecard refresh og returnerer key-count + duration.
 *
 * @returns 200 + JSON summary | 401 hvis auth fejler | 500 ved DB-fejl
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const start = Date.now();
  try {
    const runner = createDefaultSqlRunner();
    const rows = (await runner(
      'SELECT keys_updated, duration_ms FROM public.refresh_intel_scorecards()'
    )) as Array<{ keys_updated: number; duration_ms: number }>;

    const keysUpdated = rows[0]?.keys_updated ?? 0;
    const dbDurationMs = rows[0]?.duration_ms ?? 0;
    const totalMs = Date.now() - start;

    logger.log('[cron/refresh-intel-scorecards]', {
      keysUpdated,
      dbDurationMs,
      totalMs,
    });

    return NextResponse.json({
      ok: true,
      keysUpdated,
      dbDurationMs,
      totalMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    logger.error('[cron/refresh-intel-scorecards] fejl:', message);
    return NextResponse.json(
      { ok: false, error: 'Refresh fejlede', totalMs: Date.now() - start },
      { status: 500 }
    );
  }
}
