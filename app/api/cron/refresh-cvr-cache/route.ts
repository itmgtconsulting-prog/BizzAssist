/**
 * Cron: Refresh cache_cvr — /api/cron/refresh-cvr-cache
 *
 * BIZZ-1190: Finder cache_cvr rækker der er ældre end cvr_virksomhed.updated_at
 * og regenererer dem med frisk data fra cvr_virksomhed.
 *
 * Kører nightly efter pull-cvr-aendringer har opdateret cvr_virksomhed.
 *
 * Schedule: 15 4 * * * UTC (dagligt 04:15 — efter alle CVR-syncs).
 *
 * @module api/cron/refresh-cvr-cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

const BATCH_SIZE = 500;
const SAFETY_MARGIN_MS = 30_000;

/** Verificerer CRON_SECRET */
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
 * GET handler — refresher stale cache_cvr rækker.
 *
 * @param request - GET request med CRON_SECRET auth
 * @returns JSON med refresh-stats
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    {
      jobName: 'refresh-cvr-cache',
      schedule: '15 4 * * *',
      intervalMinutes: 24 * 60,
      maxRuntimeMinutes: 5,
    },
    async () => {
      const startTime = Date.now();
      const admin = createAdminClient();

      // Find stale cache_cvr rækker: cvr_virksomhed.updated_at > cache_cvr.synced_at
      // Vi bruger en SQL query for at joine de to tabeller
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: staleRows, error: queryError } = await (admin as any).rpc(
        'find_stale_cvr_cache',
        { batch_limit: 5000 }
      );

      // Fallback: Hvis RPC ikke eksisterer, brug tidsbaseret approach
      if (queryError) {
        logger.log('[refresh-cvr-cache] RPC ikke tilgængelig, bruger tidsbaseret fallback');

        // Hent virksomheder opdateret inden for 24 timer
        const yesterday = new Date(Date.now() - 86400_000).toISOString();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: recentlyUpdated, error: fetchErr } = await (admin as any)
          .from('cvr_virksomhed')
          .select('cvr_nummer,navn,branche_tekst,ophoert,adresse_json')
          .gte('updated_at', yesterday)
          .limit(5000);

        if (fetchErr || !recentlyUpdated || recentlyUpdated.length === 0) {
          return NextResponse.json({
            ok: true,
            refreshed: 0,
            message: 'Ingen ændringer inden for 24t',
          });
        }

        let refreshed = 0;
        for (let i = 0; i < recentlyUpdated.length; i += BATCH_SIZE) {
          if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) break;

          const batch = recentlyUpdated
            .slice(i, i + BATCH_SIZE)
            .map(
              (row: {
                cvr_nummer: string;
                navn: string | null;
                branche_tekst: string | null;
                ophoert: string | null;
                adresse_json: unknown;
              }) => {
                const compact = {
                  cvr: Number(row.cvr_nummer),
                  name: row.navn,
                  branche: row.branche_tekst,
                  status: row.ophoert ? 'OPHØRT' : 'NORMAL',
                  adresse: row.adresse_json,
                };
                const rawJson = JSON.stringify(compact);
                const hash = crypto.createHash('sha256').update(rawJson).digest('hex');
                return {
                  cvr_nummer: Number(row.cvr_nummer),
                  raw_data: compact,
                  source_hash: hash,
                  synced_at: new Date().toISOString(),
                };
              }
            );

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error } = await (admin as any)
            .from('cache_cvr')
            .upsert(batch, { onConflict: 'cvr_nummer' });
          if (error) {
            logger.error('[refresh-cvr-cache] Upsert fejl:', error.message);
          } else {
            refreshed += batch.length;
          }
        }

        const durationMs = Date.now() - startTime;
        logger.log(`[refresh-cvr-cache] Done: ${refreshed} refreshed, ${durationMs}ms`);

        return NextResponse.json({
          ok: true,
          recentlyUpdated: recentlyUpdated.length,
          refreshed,
          durationMs,
        });
      }

      // RPC-path (hvis find_stale_cvr_cache eksisterer)
      let refreshed = 0;
      for (let i = 0; i < (staleRows?.length ?? 0); i += BATCH_SIZE) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) break;
        const batch = staleRows.slice(i, i + BATCH_SIZE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any)
          .from('cache_cvr')
          .upsert(batch, { onConflict: 'cvr_nummer' });
        if (!error) refreshed += batch.length;
      }

      return NextResponse.json({ ok: true, refreshed, durationMs: Date.now() - startTime });
    }
  );
}
