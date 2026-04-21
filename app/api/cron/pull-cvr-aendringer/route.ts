/**
 * Cron: CVR delta-sync — /api/cron/pull-cvr-aendringer
 *
 * BIZZ-651: Dagligt 5-dages rullende vindue på Erhvervsstyrelsens CVR-permanent
 * Elasticsearch. Henter virksomheder med sidstOpdateret >= now-5d og upsert'er
 * til public.cvr_virksomhed. 5-dages overlap sikrer at cron-fejl i op til 4
 * dage fanger automatisk op på næste successful run.
 *
 * Samme pattern som BIZZ-650 (Tinglysning-delta) — search_after pagination for
 * stabil cursor + idempotent upsert.
 *
 * Schedule: 30 3 * * * UTC (dagligt 03:30 — 15 min efter Tinglysning-delta for
 * at undgå collision på Vercel runtime-budget).
 *
 * Manuel trigger: GET med Authorization: Bearer $CRON_SECRET + optional
 *   query-params ?windowDays=N&maxPages=M
 *
 * @module api/cron/pull-cvr-aendringer
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import {
  fetchCvrAendringer,
  mapVirksomhedToRow,
  upsertCvrBatch,
  type CvrRow,
} from '@/app/lib/cvrIngest';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Default 5-dages rolling window (override via ?windowDays=N) */
const DEFAULT_WINDOW_DAYS = 5;

/** ES batch-size — up til 10k men vi holder ved 1k for hukommelses-overhead */
const ES_PAGE_SIZE = 1000;

/** Safety cap på ES-batches per run */
const MAX_ES_PAGES = 250;

/** Supabase upsert-batch */
const UPSERT_BATCH_SIZE = 500;

/** Safety-margin før Vercel maxDuration */
const SAFETY_MARGIN_MS = 30_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verificerer CRON_SECRET + (i prod) Vercel cron-header.
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
 * Beregner from-date som ISO-timestamp N dage før `now`.
 * Eksporteret så unit-tests kan verificere edge-cases.
 */
export function computeCvrFromDate(now: Date, windowDays: number): string {
  const fromMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return new Date(fromMs).toISOString();
}

/**
 * Opdaterer cvr_aendring_cursor singleton med stats.
 * Best-effort — fejl her må ikke fail-markere hele cronen.
 */
async function updateCursor(stats: {
  fromDate: string;
  toDate: string;
  rowsProcessed: number;
  virksomhederProcessed: number;
  error: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('cvr_aendring_cursor').upsert(
      {
        id: 'default',
        last_run_at: new Date().toISOString(),
        last_from_date: stats.fromDate,
        last_to_date: stats.toDate,
        rows_processed: stats.rowsProcessed,
        virksomheder_processed: stats.virksomhederProcessed,
        error: stats.error,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
  } catch (err) {
    logger.error('[cvr-delta] Cursor update fejl:', err instanceof Error ? err.message : err);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    {
      jobName: 'pull-cvr-aendringer',
      schedule: '30 3 * * *',
      intervalMinutes: 24 * 60,
      maxRuntimeMinutes: 5,
    },
    async () => {
      const startTime = Date.now();

      const windowDaysRaw = request.nextUrl.searchParams.get('windowDays');
      const maxPagesRaw = request.nextUrl.searchParams.get('maxPages');
      const windowDays = windowDaysRaw ? parseInt(windowDaysRaw, 10) : DEFAULT_WINDOW_DAYS;
      const maxPages = maxPagesRaw ? parseInt(maxPagesRaw, 10) : MAX_ES_PAGES;

      const now = new Date();
      const fromDate = computeCvrFromDate(now, windowDays);
      const toDate = now.toISOString();

      logger.log(`[cvr-delta] Starter: window ${fromDate}…${toDate} (${windowDays}d)`);

      // 1. Fetch ES aendringer
      const esResult = await fetchCvrAendringer(fromDate, ES_PAGE_SIZE, maxPages);

      if (esResult.error && esResult.docs.length === 0) {
        await updateCursor({
          fromDate,
          toDate,
          rowsProcessed: 0,
          virksomhederProcessed: 0,
          error: esResult.error,
        });
        return NextResponse.json(
          { ok: false, error: esResult.error, windowDays, fromDate, toDate },
          { status: 502 }
        );
      }

      logger.log(
        `[cvr-delta] Hentet ${esResult.docs.length} virksomheder over ${esResult.pagesFetched} ES-sider`
      );

      // 2. Map + batch upsert
      const admin = createAdminClient();
      const table = admin.from('cvr_virksomhed');

      let batch: CvrRow[] = [];
      let rowsUpserted = 0;
      let rowsFailed = 0;
      let virksomhederProcessed = 0;

      for (const doc of esResult.docs) {
        // Abort hvis safety-margin ramt
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          logger.warn('[cvr-delta] Safety margin ramt — flush og stop');
          break;
        }

        const row = mapVirksomhedToRow(doc);
        if (row) {
          batch.push(row);
          virksomhederProcessed++;
        }

        if (batch.length >= UPSERT_BATCH_SIZE) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res = await upsertCvrBatch(table as any, batch);
          rowsUpserted += res.upserted;
          rowsFailed += res.failed;
          batch = [];
        }
      }

      // Final flush
      if (batch.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await upsertCvrBatch(table as any, batch);
        rowsUpserted += res.upserted;
        rowsFailed += res.failed;
      }

      // 3. Update cursor
      await updateCursor({
        fromDate,
        toDate,
        rowsProcessed: rowsUpserted,
        virksomhederProcessed,
        error: esResult.error,
      });

      const durationMs = Date.now() - startTime;
      logger.log(
        `[cvr-delta] Done: ${virksomhederProcessed}/${esResult.docs.length} virksomheder, ${rowsUpserted} upserted, ${rowsFailed} failed, ${durationMs}ms`
      );

      return NextResponse.json({
        ok: true,
        windowDays,
        fromDate,
        toDate,
        virksomhederFound: esResult.docs.length,
        pagesFetched: esResult.pagesFetched,
        virksomhederProcessed,
        rowsUpserted,
        rowsFailed,
        partialError: esResult.error,
        durationMs,
      });
    }
  );
}
