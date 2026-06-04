/**
 * Cron: backfill tinglysning_handler — /api/cron/backfill-tinglysning-handler
 *
 * BIZZ-1550: Natlig batch der populerer tinglysning_handler cache for de
 * mest-tilsete BFE'er. Reducerer cold-start latency på populære ejendomme
 * når salgshistorik-fanen åbnes.
 *
 * Strategi:
 *   1. Hent top-100 mest tilsete BFE'er fra activity log (eller fallback:
 *      ejendomme i bbr_ejendom_status sorted by last_seen)
 *   2. For hver BFE: kald backfillHandlerForBfe (genbruger callS2S + parse)
 *   3. Aggregér resultater + log oversigt
 *
 * Throttling: kører serielt med 200ms pause mellem BFE'er for at undgå
 * Tinglysning rate-limits.
 *
 * Schedule: 0 5 * * * UTC (dagligt 05:00 — efter materialized-views).
 *
 * @module api/cron/backfill-tinglysning-handler
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { backfillHandlerForBfe } from '@/app/lib/tinglysningHandlerCache';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Antal BFE'er at backfill per kørsel */
const TOP_N = 100;
/** Ms pause mellem requests */
const THROTTLE_MS = 200;

function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Vælger top-N BFE'er at backfill. Strategi:
 *   1. Stale entries (tinglysning_handler hvor sidst_opdateret < 14 dage)
 *   2. Hvis ikke nok: fallback til BBR-ejendomme med flest activity-events
 */
async function pickBfes(client: SupabaseClient): Promise<number[]> {
  // Stale-first: hent BFE'er hvis cache er udløbet
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: stale } = await client
    .from('tinglysning_handler')
    .select('bfe_nummer')
    .lt('sidst_opdateret', cutoff)
    .order('sidst_opdateret', { ascending: true })
    .limit(TOP_N);

  const staleBfes = (stale ?? [])
    .map((r: unknown) => (r as { bfe_nummer: number }).bfe_nummer)
    .filter((n): n is number => typeof n === 'number');

  if (staleBfes.length >= TOP_N) return staleBfes.slice(0, TOP_N);

  // Fallback: hent BFE'er der ALDRIG har været cached (mangler i tinglysning_handler)
  // Begræns til ejendomme som faktisk har handler i ejerskifte_historik
  const { data: untracked } = await client
    .from('ejerskifte_historik')
    .select('bfe_nummer')
    .not('bfe_nummer', 'is', null)
    .limit(TOP_N * 2);

  const untrackedBfes = Array.from(
    new Set(
      (untracked ?? [])
        .map((r: unknown) => (r as { bfe_nummer: number }).bfe_nummer)
        .filter((n): n is number => typeof n === 'number')
    )
  );

  const combined = Array.from(new Set([...staleBfes, ...untrackedBfes])).slice(0, TOP_N);
  return combined;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // BIZZ-1971: heartbeat + Sentry cron-monitoring
  return withCronMonitor(
    { jobName: 'backfill-tinglysning-handler', schedule: '0 5 * * *', intervalMinutes: 1440 },
    async () => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) {
        return NextResponse.json({ error: 'Supabase misconfigured' }, { status: 500 });
      }
      const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const start = Date.now();
      const bfes = await pickBfes(client);
      if (bfes.length === 0) {
        return NextResponse.json({ ok: true, processed: 0, totalMs: Date.now() - start });
      }

      let successCount = 0;
      let failCount = 0;
      let totalRows = 0;
      for (const bfe of bfes) {
        try {
          const n = await backfillHandlerForBfe(bfe);
          if (n > 0) {
            successCount++;
            totalRows += n;
          }
        } catch (err) {
          failCount++;
          logger.warn('[cron/backfill-tinglysning-handler] BFE fejl', { bfe, err });
        }
        await sleep(THROTTLE_MS);
      }

      const totalMs = Date.now() - start;
      logger.log('[cron/backfill-tinglysning-handler]', {
        requested: bfes.length,
        successCount,
        failCount,
        totalRows,
        totalMs,
      });

      return NextResponse.json({
        ok: failCount === 0,
        requested: bfes.length,
        successCount,
        failCount,
        totalRows,
        totalMs,
      });
    }
  );
}
