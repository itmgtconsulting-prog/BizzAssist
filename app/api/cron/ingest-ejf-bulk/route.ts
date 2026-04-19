/**
 * Cron: Ingest EJF bulk data — /api/cron/ingest-ejf-bulk
 *
 * BIZZ-534: Daglig bulk-ingest af EJF (Ejendoms-Fortegnelsen) ejerskabs-data
 * fra Datafordeler. Bygger public.ejf_ejerskab op så vi kan svare på
 * person→ejendomme uden grant til EJF_Ejerskab live-API.
 *
 * Strategi:
 *   1. Download seneste EJF-dump fra Datafordeler bulk-data endpoint
 *      (typisk JSON eller XML med komplet ejerskab-snapshot)
 *   2. Stream-parse for at undgå memory blowup på store filer (~GB-skala)
 *   3. UPSERT batches af 1000 rækker mod public.ejf_ejerskab
 *   4. Markér rækker der ikke længere findes som status='historisk'
 *      (soft-delete via virkning_til = now())
 *   5. Log run-stats til public.ejf_ingest_runs
 *
 * Sikring:
 *   - CRON_SECRET bearer + x-vercel-cron header i prod
 *   - Service role bypasser RLS for skrivning
 *   - Idempotent: kan re-køre uden duplikater (PK på bfe_nummer+ejer_ejf_id+virkning_fra)
 *
 * Trigger:
 *   - Vercel Cron: dagligt kl. 04:00 UTC
 *   - Manuel: GET /api/cron/ingest-ejf-bulk med Authorization: Bearer <CRON_SECRET>
 *
 * IMPLEMENTATION STATUS (2026-04-19):
 *   Skeleton + database scaffolding er på plads. SELVE DOWNLOAD-LOGIKKEN
 *   er placeholder — den faktiske Datafordeler EJF bulk-data URL og
 *   format skal verificeres med Datafordeler-team / dokumentation.
 *   Skeleton kører idempotent med 0 rows hvis DOWNLOAD_URL ikke er sat.
 *
 *   Næste skridt for at få fuld funktionalitet:
 *   1. Find korrekt bulk-download URL hos Datafordeler
 *      (https://datafordeler.dk/dataoversigt/ejendomsbeliggenhed/)
 *   2. Implementer streaming-parser for det specifikke format
 *      (typisk gz-XML eller gz-JSON-Lines)
 *   3. Tilføj env: EJF_BULK_DUMP_URL
 *   4. Opdater vercel.json med cron-schedule
 *
 * @module api/cron/ingest-ejf-bulk
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min — bulk-ingest kan tage tid på store dumps

/**
 * Verificerer at kaldet er autoriseret via CRON_SECRET + (i prod) Vercel cron header.
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
 * GET /api/cron/ingest-ejf-bulk
 * Triggerer EJF bulk-ingest. Skeleton-implementation pt.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dumpUrl = process.env.EJF_BULK_DUMP_URL;
  const admin = createAdminClient();

  // BIZZ-534: public.ejf_ingest_runs er en ny tabel der endnu ikke er i
  // auto-generated supabase types — cast .from() til any for at tillade
  // kompil. Regenerate types post-merge.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ingestRuns = (admin as any).from('ejf_ingest_runs');

  // Opret run-row så vi kan tracke status uanset om download er konfigureret
  const { data: runRow, error: runErr } = await ingestRuns
    .insert({ started_at: new Date().toISOString() })
    .select('id')
    .single();

  if (runErr) {
    logger.error('[ingest-ejf-bulk] Kan ikke oprette run-row:', runErr.message);
    return NextResponse.json({ ok: false, error: 'Run-tracking fejlede' }, { status: 500 });
  }

  const runId = runRow!.id as number;

  // ── Skeleton-mode: ingen DUMP_URL konfigureret ───────────────────────────
  if (!dumpUrl) {
    const note =
      'EJF_BULK_DUMP_URL ikke sat — skeleton-mode. ' +
      'Sæt env-variabel når Datafordeler bulk-endpoint er identificeret.';
    logger.warn('[ingest-ejf-bulk]', note);
    await ingestRuns
      .update({
        finished_at: new Date().toISOString(),
        rows_processed: 0,
        rows_inserted: 0,
        rows_updated: 0,
        rows_failed: 0,
        error: note,
      })
      .eq('id', runId);
    return NextResponse.json({ ok: true, skeleton: true, note });
  }

  // ── Faktisk download + parse ────────────────────────────────────────────
  // PLACEHOLDER: Udskift med rigtig stream-parsing når format er kendt.
  // Forventet flow:
  //   const stream = await fetch(dumpUrl).then(r => r.body);
  //   const decoded = stream.pipeThrough(new DecompressionStream('gzip'));
  //   for await (const record of parseEjfRecords(decoded)) {
  //     batch.push(mapToRow(record));
  //     if (batch.length >= 1000) await flushBatch(batch);
  //   }
  const processed = 0;
  const inserted = 0;
  const updated = 0;
  const failed = 0;
  let error: string | null = null;

  try {
    // TODO: Implementer faktisk download når URL er kendt.
    error = 'Ingest-logik ikke implementeret endnu — kun skeleton.';
    logger.warn('[ingest-ejf-bulk]', error);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error('[ingest-ejf-bulk] Fejl:', error);
  }

  await ingestRuns
    .update({
      finished_at: new Date().toISOString(),
      rows_processed: processed,
      rows_inserted: inserted,
      rows_updated: updated,
      rows_failed: failed,
      error,
    })
    .eq('id', runId);

  return NextResponse.json({
    ok: error == null,
    runId,
    rows: { processed, inserted, updated, failed },
    error,
  });
}
