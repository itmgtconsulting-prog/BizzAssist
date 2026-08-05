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
  // BIZZ-2056: flad handler-MV bag boligpris-tabellen. Skal refreshes dagligt
  // sammen med KPI-MV'en så tabellens rækker matcher KPI-tallet. Whitelistet i
  // refresh_materialized_view() RPC i migration 173.
  'mv_boligpris_handler',
  // BIZZ-2054: M&A-radarens kandidat-MV. Lå tidligere ikke på nogen
  // refresh-sti → radaren frøs på sidste manuelle refresh. Whitelistet i
  // refresh_materialized_view() RPC i migration 170.
  'mv_virksomhedshandel_kandidater',
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // BIZZ-1971 + BIZZ-2209: heartbeat + degraded-rapportering ved refresh-fejl.
  return withCronMonitor('refresh-materialized-views', async () => {
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

    // BIZZ-2209: rapportér degraded/error når MV-refreshes fejler, så watchdoggen
    // fanger det (før returnerede cronen altid ok:true → frysning gik 63 dage
    // uopdaget). failed>0 = degraded; alle fejlet = error (via throw i wrapper).
    const failed = results.filter((r) => !r.ok);
    const okCount = results.length - failed.length;
    const degraded =
      failed.length > 0
        ? `${failed.length}/${results.length} MV-refresh fejlede: ${failed.map((f) => f.view).join(', ')}`
        : undefined;

    return {
      response: NextResponse.json({ ok: failed.length === 0, results }),
      metrics: { itemsProcessed: results.length, itemsWritten: okCount },
      degraded,
    };
  });
}
