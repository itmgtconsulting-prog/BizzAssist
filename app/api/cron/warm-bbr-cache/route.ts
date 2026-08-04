/**
 * Cron: warm-bbr-cache — proaktivt BBR-cache for populære ejendomme.
 *
 * BIZZ-1016: Henter BBR-data for top-N mest besøgte ejendomme og gemmer
 * i cache_bbr (JSONB). Supplerer write-on-read fra BIZZ-1015.
 *
 * Flow:
 *   1. Hent top 200 BFE-numre fra bbr_ejendom_status (allerede cached)
 *   2. For hver: tjek om cache_bbr har frisk data (< 7 dage)
 *   3. Hvis stale/manglende: hent DAWA adresse-id → fetchBbrForAddress → gem
 *   4. Max 500 fetch per kørsel (Datafordeler rate limit)
 *
 * Schedule: dagligt kl. 04:30 UTC (efter pull-bbr-events)
 *
 * @module api/cron/warm-bbr-cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { hentBfeAdresse } from '@/app/lib/bfeAdresse';
import { recordSyncStatus } from '@/app/lib/dataSyncStatus';
import crypto from 'crypto';

export const maxDuration = 300;

/** Max ejendomme at cache per kørsel */
const MAX_PER_RUN = 200;

/** Cache staleness (7 dage) */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Pause mellem fetch-kald (ms) for at respektere rate limits */
const THROTTLE_MS = 500;

/**
 * Verificer CRON_SECRET + x-vercel-cron header.
 *
 * @param request - Indkommende request
 * @returns true hvis autentificeret
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
 * Hent BFE-numre der skal caches — fra bbr_ejendom_status (allerede populeret).
 * Prioriterer ejendomme der ikke allerede har frisk cache.
 *
 * @returns Array af BFE-numre at cache
 */
async function fetchBfeToWarm(): Promise<number[]> {
  const admin = createAdminClient();

  // Hent BFE-numre fra bbr_ejendom_status der mangler eller har stale cache_bbr
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).rpc('get_stale_bbr_cache_bfe', {
    p_cutoff: cutoff,
    p_limit: MAX_PER_RUN,
  });

  if (error) {
    // Fallback: hent bare fra bbr_ejendom_status (random udsnit)
    logger.warn('[warm-bbr-cache] RPC ikke tilgængelig, falder til direkte query:', error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: fallback } = await (admin as any)
      .from('bbr_ejendom_status')
      .select('bfe_nummer')
      .limit(MAX_PER_RUN);

    return (fallback ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer);
  }

  return (data ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer);
}

/**
 * Resolve BFE → DAWA adgangsadresse-id (nødvendigt for fetchBbrForAddress).
 *
 * BIZZ-2209: Brugte tidligere DAWA's nedlagte `/bfe/{bfe}`-endpoint (nedlagt
 * ~maj 2026), hvilket fik hver resolve til at returnere null → warm-bbr-cache
 * skrev 0 rækker i 81 dage (cache_bbr frøs). Bruger nu den fælles, fungerende
 * BFE→adresse-resolver (jordstykker→adgangsadresser), jf. bfeAdresse.ts.
 *
 * @param bfe - BFE-nummer
 * @returns DAWA adgangsadresse UUID eller null
 */
async function resolveDawaId(bfe: number): Promise<string | null> {
  try {
    const adr = await hentBfeAdresse(bfe);
    return adr?.dawaId ?? null;
  } catch {
    return null;
  }
}

/**
 * GET handler — kører som Vercel cron job.
 *
 * @param request - Indkommende Next.js request (auth header)
 * @returns JSON med { warmed, skipped, errors, total }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  return withCronMonitor('warm-bbr-cache', async () => {
    const admin = createAdminClient();
    const bfeList = await fetchBfeToWarm();

    if (bfeList.length === 0) {
      // expectsWork-job uden kandidater → auto-degraderes af withCronMonitor.
      await recordSyncStatus('cache_bbr', { rowsSynced: 0, durationMs: Date.now() - startedAt });
      return {
        response: NextResponse.json({
          warmed: 0,
          skipped: 0,
          errors: 0,
          message: 'Ingen BFE at cache',
        }),
        metrics: { itemsProcessed: 0, itemsWritten: 0 },
      };
    }

    let warmed = 0;
    let skipped = 0;
    let errors = 0;

    for (const bfe of bfeList) {
      try {
        // Tjek om cache allerede er frisk
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: existing } = await (admin as any)
          .from('cache_bbr')
          .select('synced_at')
          .eq('bfe_nummer', bfe)
          .single();

        if (existing?.synced_at) {
          const age = Date.now() - new Date(existing.synced_at).getTime();
          if (age < STALE_MS) {
            skipped++;
            continue;
          }
        }

        // Resolve DAWA id
        const dawaId = await resolveDawaId(bfe);
        if (!dawaId) {
          errors++;
          continue;
        }

        // Hent BBR data
        const result = await fetchBbrForAddress(dawaId);
        if (!result) {
          errors++;
          continue;
        }

        // Gem i cache_bbr
        const rawJson = JSON.stringify(result);
        const hash = crypto.createHash('sha256').update(rawJson).digest('hex');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (admin as any).from('cache_bbr').upsert(
          {
            bfe_nummer: bfe,
            raw_data: result,
            source_hash: hash,
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'bfe_nummer' }
        );

        warmed++;

        // Throttle
        if (warmed % 10 === 0) {
          await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
        }
      } catch (err) {
        logger.warn(`[warm-bbr-cache] BFE ${bfe} fejl:`, err instanceof Error ? err.message : err);
        errors++;
      }
    }

    logger.log(`[warm-bbr-cache] Færdig: warmed=${warmed}, skipped=${skipped}, errors=${errors}`);

    // Degraded hvis alt fejlede og intet blev warmet trods stale kandidater —
    // dét fanger en broken afhængighed (fx den nedlagte DAWA /bfe før BIZZ-2209).
    // (Alle kandidater friske → warmed=0, errors=0 = healthy, ikke degraded.)
    const degraded = warmed === 0 && errors > 0 ? `${errors} BFE-resolves fejlede` : undefined;

    await recordSyncStatus('cache_bbr', {
      rowsSynced: warmed,
      durationMs: Date.now() - startedAt,
      error: degraded,
    });

    return {
      response: NextResponse.json({ warmed, skipped, errors, total: bfeList.length }),
      // itemsProcessed = kandidater undersøgt (ikke kun warmed+errors), så en
      // kørsel hvor alt var frisk ikke fejlagtigt tælles som "intet arbejde".
      metrics: { itemsProcessed: bfeList.length, itemsWritten: warmed },
      degraded,
    };
  });
}
