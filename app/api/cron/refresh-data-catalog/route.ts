/**
 * Cron: Data Catalog Refresh — /api/cron/refresh-data-catalog
 *
 * BIZZ-1408: Natlig opdatering af dataintel.data_catalog. Kører ANALYZE
 * på hver whitelistet tabel og henter pg_stats for null-rate, n_distinct
 * og top-values. Resultaterne injiceres i AI system prompt (BIZZ-1410).
 *
 * Schedule: 0 3 * * * UTC (dagligt 03:00 — før knowledge cache 03:30).
 *
 * Manuel trigger: GET med Authorization: Bearer $CRON_SECRET
 *
 * @module api/cron/refresh-data-catalog
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { buildAndUpsertCatalog } from '@/app/lib/dataIntelligence/buildCatalog';

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
 * GET handler — kører catalog refresh og returnerer per-tabel summary.
 *
 * @returns 200 + JSON summary | 401 hvis auth fejler
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const start = Date.now();
  try {
    const { results } = await buildAndUpsertCatalog();
    const totalRows = results.reduce((sum, r) => sum + r.rows, 0);
    const failed = results.filter((r) => r.error).length;
    const durationMs = Date.now() - start;

    logger.log('[cron/refresh-data-catalog]', {
      tables: results.length,
      totalRows,
      failed,
      durationMs,
    });

    return NextResponse.json({
      ok: failed === 0,
      tables: results.length,
      totalRows,
      failed,
      durationMs,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    logger.error('[cron/refresh-data-catalog] fatal:', msg);
    return NextResponse.json(
      { ok: false, error: 'Ekstern API fejl', durationMs: Date.now() - start },
      { status: 500 }
    );
  }
}
