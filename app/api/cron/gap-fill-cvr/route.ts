/**
 * Cron: CVR gap-fill — /api/cron/gap-fill-cvr
 *
 * Finder CVR-numre der refereres i cvr_deltagerrelation men MANGLER i
 * cvr_virksomhed. Henter dem fra Erhvervsstyrelsens CVR ES og upsert'er.
 *
 * Løser cache-coherence-gap: cvr_deltagerrelation backfill'ede 1.8M deltagere
 * med relationer til virksomheder der aldrig kom ind i cvr_virksomhed.
 *
 * Schedule: 30 5 * * * UTC (dagligt 05:30 — efter pull-cvr-aendringer)
 *
 * @module api/cron/gap-fill-cvr
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import {
  getCvrEsAuthHeader,
  mapVirksomhedToRow,
  upsertCvrBatch,
  type VrvirksomhedDoc,
} from '@/app/lib/cvrIngest';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Antal manglende CVR'er per batch */
const GAP_BATCH_SIZE = 200;

/** Max CVR'er at fylde per kørsel */
const MAX_FILLS_PER_RUN = 500;

/** ES batch-size per terms-query */
const ES_BATCH_SIZE = 50;

/** Safety-margin før Vercel maxDuration */
const SAFETY_MARGIN_MS = 30_000;

/**
 * Verificerer CRON_SECRET + (i prod) Vercel cron-header.
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  const bearer = request.headers.get('authorization')?.replace('Bearer ', '');
  if (!secret || !bearer) return false;
  return safeCompare(secret, bearer);
}

/**
 * Hent virksomheder fra CVR ES via terms-filter (batch-lookup by CVR).
 *
 * @param cvrs - CVR-numre at hente
 * @param auth - Basic Auth header
 * @returns Vrvirksomhed docs
 */
async function fetchCvrsByIds(cvrs: string[], auth: string): Promise<VrvirksomhedDoc[]> {
  if (cvrs.length === 0) return [];

  const body = {
    size: cvrs.length,
    query: { terms: { 'Vrvirksomhed.cvrNummer': cvrs.map(Number) } },
  };

  const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    logger.error(`[gap-fill-cvr] CVR ES HTTP ${res.status}`);
    return [];
  }

  const json = (await res.json()) as {
    hits?: {
      hits?: Array<{ _source?: { Vrvirksomhed?: VrvirksomhedDoc } }>;
    };
  };

  return (json.hits?.hits ?? [])
    .map((h) => h._source?.Vrvirksomhed)
    .filter((v): v is VrvirksomhedDoc => v != null);
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    {
      jobName: 'gap-fill-cvr',
      schedule: '30 5 * * *',
      intervalMinutes: 24 * 60,
      maxRuntimeMinutes: 5,
    },
    async () => {
      const auth = getCvrEsAuthHeader();
      if (!auth) {
        return NextResponse.json({ error: 'CVR_ES_USER/PASS ikke konfigureret' }, { status: 500 });
      }

      const admin = createAdminClient();
      const startMs = Date.now();
      let totalFilled = 0;
      let totalMissing = 0;
      let offset = 0;

      while (totalFilled < MAX_FILLS_PER_RUN) {
        if (Date.now() - startMs > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          logger.log(`[gap-fill-cvr] Stopper pga. tidsbegrænsning (${totalFilled} fyldt)`);
          break;
        }

        // Hent batch af distinkte CVR'er fra deltagerrelation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: relRows } = await (admin as any)
          .from('cvr_deltagerrelation')
          .select('virksomhed_cvr')
          .not('virksomhed_cvr', 'is', null)
          .range(offset, offset + GAP_BATCH_SIZE - 1);

        const cvrs = [
          ...new Set(
            ((relRows ?? []) as Array<{ virksomhed_cvr: string }>).map((r) => r.virksomhed_cvr)
          ),
        ];
        if (cvrs.length === 0) break;

        // Check hvilke der mangler i cvr_virksomhed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: existing } = await (admin as any)
          .from('cvr_virksomhed')
          .select('cvr')
          .in('cvr', cvrs);
        const existingSet = new Set(((existing ?? []) as Array<{ cvr: string }>).map((r) => r.cvr));
        const missing = cvrs.filter((c) => !existingSet.has(c));

        offset += GAP_BATCH_SIZE;

        if (missing.length === 0) continue;
        totalMissing += missing.length;

        // Hent fra CVR ES i batches
        for (let i = 0; i < missing.length; i += ES_BATCH_SIZE) {
          const batch = missing.slice(i, i + ES_BATCH_SIZE);
          const docs = await fetchCvrsByIds(batch, auth);
          if (docs.length > 0) {
            const rows = docs
              .map(mapVirksomhedToRow)
              .filter((r): r is NonNullable<typeof r> => r != null);
            if (rows.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const res = await upsertCvrBatch((admin as any).from('cvr_virksomhed'), rows);
              totalFilled += res.upserted;
            }
          }
        }
      }

      const summary = {
        ok: true,
        totalMissing,
        totalFilled,
        durationMs: Date.now() - startMs,
      };
      logger.log('[gap-fill-cvr] Færdig:', JSON.stringify(summary));

      return NextResponse.json(summary);
    }
  );
}
