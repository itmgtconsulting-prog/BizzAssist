/**
 * GET /api/cron/refresh-materialized-views
 *
 * BIZZ-920: Refresher materialized views for krydsanalyser.
 * Kører dagligt efter data-sync (05:00 UTC).
 *
 * @module api/cron/refresh-materialized-views
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Verificerer CRON_SECRET bearer + x-vercel-cron (i produktion).
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

const VIEWS = ['mv_virksomhed_portefolje', 'mv_kommune_statistik'];

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  const results: Array<{ view: string; ok: boolean; durationMs: number; error?: string }> = [];

  for (const view of VIEWS) {
    const start = Date.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any).rpc('refresh_materialized_view', { view_name: view });
      if (error) {
        // Fallback: direct SQL (kræver supabase admin med SQL-adgang)
        logger.warn(`[refresh-mv] RPC fejl for ${view}:`, error.message);
        results.push({ view, ok: false, durationMs: Date.now() - start, error: error.message });
      } else {
        results.push({ view, ok: true, durationMs: Date.now() - start });
      }
    } catch (err) {
      results.push({
        view,
        ok: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }

    // Opdater sync-status
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('data_sync_status')
      .upsert(
        {
          source_name: view,
          last_sync_at: new Date().toISOString(),
          last_success: results[results.length - 1].ok ? new Date().toISOString() : undefined,
          sync_duration_ms: results[results.length - 1].durationMs,
          last_error: results[results.length - 1].error ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'source_name' }
      )
      .catch(() => {});
  }

  return NextResponse.json({ ok: true, results });
}
