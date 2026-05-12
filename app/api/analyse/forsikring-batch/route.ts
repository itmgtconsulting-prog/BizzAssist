/**
 * POST /api/analyse/forsikring-batch
 * GET  /api/analyse/forsikring-batch?jobId=xxx
 *
 * BIZZ-1224: Batch forsikrings-gap-analyse for kundeporteføljer.
 *
 * POST: Opretter batch-job fra uploadet CSV/Excel med kunder + policer.
 *       Returnerer jobId for polling.
 * GET:  Returnerer job-status + resultater (partial under processing).
 *
 * @param request - POST med { kunder: BatchKunde[] } eller GET med ?jobId=
 * @returns { jobId, status, progress, results?, summary? }
 * @retention Resultater gemmes i tenant.analyse_batch_jobs (tenant-scoped).
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminAny = any;

export const maxDuration = 60;

/** En kunde i batch-uploaden */
interface BatchKunde {
  /** Unik kunde-ID (fra CSV) */
  kundeId: string;
  /** Kundenavn */
  navn: string;
  /** person eller virksomhed */
  kundeType: 'person' | 'virksomhed';
  /** CVR eller enhedsNummer */
  identifier: string;
  /** Policer for denne kunde (parsed fra CSV) */
  policer: Array<{
    type: string;
    daekningssum: number | null;
    objekt: string | null;
  }>;
}

/** POST body */
interface BatchCreateBody {
  kunder: BatchKunde[];
}

/** Job-status response */
interface BatchStatusResponse {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  totalItems: number;
  processedItems: number;
  /** Progress 0-100 */
  progress: number;
  results: unknown[] | null;
  summary: unknown | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * POST — opret batch-job fra parsed kundeliste.
 *
 * @param request - POST body med kunder-array
 * @returns { jobId } eller fejl
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  let body: BatchCreateBody;
  try {
    body = (await request.json()) as BatchCreateBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.kunder || !Array.isArray(body.kunder) || body.kunder.length === 0) {
    return NextResponse.json({ error: 'Ingen kunder i batch' }, { status: 400 });
  }

  if (body.kunder.length > 5000) {
    return NextResponse.json({ error: 'Maks 5000 kunder per batch' }, { status: 400 });
  }

  const admin = createAdminClient() as AdminAny;

  try {
    const { data: job, error: insertErr } = await admin
      .schema('tenant')
      .from('analyse_batch_jobs')
      .insert({
        tenant_id: auth.tenantId,
        user_id: auth.userId,
        job_type: 'forsikring-gap',
        status: 'pending',
        input_data: body.kunder,
        total_items: body.kunder.length,
        processed_items: 0,
      })
      .select('id')
      .single();

    if (insertErr || !job) {
      logger.error('[forsikring-batch] Insert fejl:', insertErr?.message);
      return NextResponse.json({ error: 'Kunne ikke oprette batch-job' }, { status: 500 });
    }

    // Start processing asynkront via edge function eller cron
    // For nu: trigger processing i baggrunden via fire-and-forget fetch
    const host = request.headers.get('host') ?? 'localhost:3000';
    const cookie = request.headers.get('cookie') ?? '';
    const base = host.startsWith('localhost') ? `http://${host}` : `https://${host}`;

    void fetch(`${base}/api/analyse/forsikring-batch/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ jobId: job.id }),
      signal: AbortSignal.timeout(55000),
    }).catch((err) => {
      logger.warn('[forsikring-batch] Background process trigger failed:', err);
    });

    return NextResponse.json({ jobId: job.id, status: 'pending' });
  } catch (err) {
    logger.error('[forsikring-batch] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

/**
 * GET — hent job-status og resultater.
 *
 * @param request - GET med ?jobId=uuid
 * @returns BatchStatusResponse
 */
export async function GET(request: NextRequest): Promise<NextResponse<BatchStatusResponse>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' } as unknown as BatchStatusResponse, {
      status: 401,
    });
  }

  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json({ error: 'Mangler jobId' } as unknown as BatchStatusResponse, {
      status: 400,
    });
  }

  const admin = createAdminClient() as AdminAny;
  const { data: job, error: fetchErr } = await admin
    .schema('tenant')
    .from('analyse_batch_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('tenant_id', auth.tenantId)
    .single();

  if (fetchErr || !job) {
    return NextResponse.json({ error: 'Job ikke fundet' } as unknown as BatchStatusResponse, {
      status: 404,
    });
  }

  const response: BatchStatusResponse = {
    jobId: job.id as string,
    status: job.status as BatchStatusResponse['status'],
    totalItems: (job.total_items as number) ?? 0,
    processedItems: (job.processed_items as number) ?? 0,
    progress:
      (job.total_items as number) > 0
        ? Math.round(((job.processed_items as number) / (job.total_items as number)) * 100)
        : 0,
    results: (job.results as unknown[]) ?? null,
    summary: (job.summary as unknown) ?? null,
    error: (job.error as string) ?? null,
    createdAt: job.created_at as string,
    completedAt: (job.completed_at as string) ?? null,
  };

  return NextResponse.json(response);
}
