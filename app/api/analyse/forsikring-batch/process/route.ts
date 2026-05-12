/**
 * POST /api/analyse/forsikring-batch/process
 *
 * BIZZ-1224: Batch-processor for forsikrings-gap-analyse.
 * Processerer kunder sekventielt, kalder /api/analyse/forsikring-gap
 * per kunde, og opdaterer job-status i tenant.analyse_batch_jobs.
 *
 * Rate-limited: 2 kunder/sekund for at respektere eksterne API-grænser.
 * Checkpoint: gemmer progress efter hver kunde, så jobs kan genoptages.
 *
 * @param request - POST med { jobId: string }
 * @returns { processed, failed }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import type { GapAnalyseResult } from '@/app/api/analyse/forsikring-gap/route';

export const maxDuration = 300;

/** Delay mellem kunder (ms) — 2 req/sec */
const DELAY_BETWEEN_CUSTOMERS_MS = 500;

/** Max kunder per process-kald (Vercel 300s timeout) */
const MAX_PER_BATCH = 200;

/**
 * POST — processér batch-job.
 *
 * @param request - POST med { jobId: string }
 * @returns Processeringsstatus
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { jobId: string };
  try {
    body = (await request.json()) as { jobId: string };
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.jobId) {
    return NextResponse.json({ error: 'Mangler jobId' }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // Hent job
  const { data: job, error: fetchErr } = await admin
    .schema('tenant')
    .from('analyse_batch_jobs')
    .select('*')
    .eq('id', body.jobId)
    .eq('tenant_id', auth.tenantId)
    .single();

  if (fetchErr || !job) {
    return NextResponse.json({ error: 'Job ikke fundet' }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = job as any;

  if (j.status === 'completed' || j.status === 'failed') {
    return NextResponse.json({ error: 'Job er allerede afsluttet' }, { status: 400 });
  }

  // Marker som processing
  await admin
    .schema('tenant')
    .from('analyse_batch_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', body.jobId);

  const kunder =
    (j.input_data as Array<{
      kundeId: string;
      navn: string;
      kundeType: 'person' | 'virksomhed';
      identifier: string;
      policer: Array<{ type: string; daekningssum: number | null; objekt: string | null }>;
    }>) ?? [];

  const existingResults = ((j.results as unknown[]) ?? []) as Array<{
    kundeId: string;
    navn: string;
    result: GapAnalyseResult | null;
    error: string | null;
  }>;

  // Resume fra sidst processerede
  const startIdx = j.processed_items as number;
  const endIdx = Math.min(kunder.length, startIdx + MAX_PER_BATCH);

  const host = request.headers.get('host') ?? 'localhost:3000';
  const cookie = request.headers.get('cookie') ?? '';
  const base = host.startsWith('localhost') ? `http://${host}` : `https://${host}`;

  const results = [...existingResults];
  let processed = startIdx;
  let failed = 0;

  try {
    for (let i = startIdx; i < endIdx; i++) {
      const kunde = kunder[i];

      try {
        const res = await fetch(`${base}/api/analyse/forsikring-gap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie },
          body: JSON.stringify({
            kundeType: kunde.kundeType,
            kundeId: kunde.identifier,
            policer: kunde.policer.map((p) => ({
              type: p.type,
              rawType: p.type,
              daekningssum: p.daekningssum,
              selskab: null,
              objekt: p.objekt,
              policenummer: null,
              udloebsdato: null,
            })),
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (res.ok) {
          const data = (await res.json()) as GapAnalyseResult;
          results.push({ kundeId: kunde.kundeId, navn: kunde.navn, result: data, error: null });
        } else {
          const errData = await res.json().catch(() => null);
          results.push({
            kundeId: kunde.kundeId,
            navn: kunde.navn,
            result: null,
            error: (errData as { error?: string })?.error ?? `HTTP ${res.status}`,
          });
          failed++;
        }
      } catch (err) {
        results.push({
          kundeId: kunde.kundeId,
          navn: kunde.navn,
          result: null,
          error: err instanceof Error ? err.message : 'Ukendt fejl',
        });
        failed++;
      }

      processed++;

      // Checkpoint: gem progress efter hver kunde
      if (processed % 10 === 0 || processed === endIdx) {
        await admin
          .schema('tenant')
          .from('analyse_batch_jobs')
          .update({ processed_items: processed, results })
          .eq('id', body.jobId);
      }

      // Rate limiting
      if (i < endIdx - 1) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_CUSTOMERS_MS));
      }
    }

    // Beregn summary
    const completedResults = results.filter((r) => r.result);
    const totalGaps = completedResults.reduce((s, r) => s + (r.result?.gaps?.length ?? 0), 0);
    const totalAktiver = completedResults.reduce((s, r) => s + (r.result?.aktiver?.length ?? 0), 0);
    const totalUforsikrede = completedResults.reduce(
      (s, r) => s + (r.result?.summary?.uforsikrede ?? 0),
      0
    );

    // Gap-type fordeling
    const gapTypeCounts: Record<string, number> = {};
    for (const r of completedResults) {
      for (const gap of r.result?.gaps ?? []) {
        gapTypeCounts[gap.gapType] = (gapTypeCounts[gap.gapType] ?? 0) + 1;
      }
    }

    // Sortér kunder efter antal gaps (mest → mindst)
    const kundeRanking = completedResults
      .map((r) => ({
        kundeId: r.kundeId,
        navn: r.navn,
        antalGaps: r.result?.gaps?.length ?? 0,
        antalUforsikrede: r.result?.summary?.uforsikrede ?? 0,
        samletVaerdi: r.result?.summary?.samletVaerdi ?? 0,
      }))
      .sort((a, b) => b.antalGaps - a.antalGaps);

    const summary = {
      totalKunder: kunder.length,
      processeret: processed,
      fejlet: failed,
      totalGaps,
      totalAktiver,
      totalUforsikrede,
      gapTypeCounts,
      topKunder: kundeRanking.slice(0, 50),
    };

    const isComplete = processed >= kunder.length;

    await admin
      .schema('tenant')
      .from('analyse_batch_jobs')
      .update({
        processed_items: processed,
        results,
        summary,
        status: isComplete ? 'completed' : 'processing',
        completed_at: isComplete ? new Date().toISOString() : null,
      })
      .eq('id', body.jobId);

    // Trigger næste batch hvis ikke færdig
    if (!isComplete) {
      void fetch(`${base}/api/analyse/forsikring-batch/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ jobId: body.jobId }),
        signal: AbortSignal.timeout(55000),
      }).catch(() => {});
    }

    return NextResponse.json({ processed, failed, isComplete });
  } catch (err) {
    logger.error('[forsikring-batch/process] Fatal:', err);

    await admin
      .schema('tenant')
      .from('analyse_batch_jobs')
      .update({
        status: 'failed',
        error: err instanceof Error ? err.message : 'Ukendt fejl',
        processed_items: processed,
        results,
      })
      .eq('id', body.jobId);

    return NextResponse.json({ error: 'Processing fejlede' }, { status: 500 });
  }
}
