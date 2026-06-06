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
import { withCronMonitor } from '@/app/lib/cronMonitor';

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

/**
 * Rækkefølge er vigtig:
 *   1. Base-views først (mv_analyse_*) — bruges af andre views/queries
 *   2. Nye master views (118-121) — afhænger af base-tabeller
 *   3. Portefølje/statistik sidst — afhænger af master views
 */
const VIEWS = [
  'mv_analyse_ejendom',
  'mv_analyse_virksomhed',
  'mv_ejendom_master',
  'mv_ejerskab_beriget',
  'mv_virksomhed_struktur',
  'mv_deltager_beriget',
  'mv_virksomhed_portefolje',
  'mv_kommune_statistik',
  'mv_boligpris_maaned',
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // BIZZ-1971: heartbeat + Sentry cron-monitoring
  return withCronMonitor(
    { jobName: 'refresh-materialized-views', schedule: '0 5 * * *', intervalMinutes: 1440 },
    async () => {
      const admin = createAdminClient();
      const results: Array<{ view: string; ok: boolean; durationMs: number; error?: string }> = [];

      for (const view of VIEWS) {
        const start = Date.now();
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error } = await (admin as any).rpc('refresh_materialized_view', {
            view_name: view,
          });
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
        const { error: syncErr } = await (admin as any).from('data_sync_status').upsert(
          {
            source_name: view,
            last_sync_at: new Date().toISOString(),
            last_success: results[results.length - 1].ok ? new Date().toISOString() : undefined,
            sync_duration_ms: results[results.length - 1].durationMs,
            last_error: results[results.length - 1].error ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'source_name' }
        );
        if (syncErr) logger.warn('[mv-refresh] Sync status update fejl:', syncErr.message);
      }

      return NextResponse.json({ ok: true, results });
    }
  );
}
