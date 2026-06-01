/**
 * Cron: EJF delta-sync orchestrator — /api/cron/sync-ejf-all
 *
 * BIZZ-1954: Samler de tre relaterede daglige EJF-delta-syncs i ÉT cron-job,
 * så vi holder os under Vercel Pro's 40-cron-grænse. De underliggende routes er
 * UÆNDREDE — denne orchestrator fyrer dem blot sekventielt via interne HTTP-kald:
 *   1. /api/cron/sync-ejf-ejerskifte
 *   2. /api/cron/sync-ejf-handelsoplysninger
 *   3. /api/cron/sync-ejf-administrator
 *
 * Hver sub-route kører i sin EGEN serverless-invocation med fuldt 5-min-budget
 * og sin egen cursor + heartbeat (per-job-monitorering bevares). Orchestratoren
 * timeboxer hvert kald (under sit eget maxDuration), men sub-routen fortsætter
 * server-side selv hvis klient-kaldet abortes — den gemmer fremskridt løbende,
 * så et afbrudt backfill-kald genoptages næste dag uden datatab.
 *
 * Sikring:
 *   - CRON_SECRET bearer + x-vercel-cron header i prod (samme gate som sub-routes)
 *
 * Trigger:
 *   - Vercel Cron: dagligt kl. 05:00 UTC (erstatter 3 separate cron-entries)
 *   - Manuel: GET med Authorization: Bearer <CRON_SECRET>
 *
 * Retention: skriver ingen ny data selv — kun heartbeat via withCronMonitor.
 *
 * @module api/cron/sync-ejf-all
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min

/** Sub-routes der fyres i rækkefølge (relaterede EJF delta-syncs). */
const SUB_JOBS = [
  'sync-ejf-ejerskifte',
  'sync-ejf-handelsoplysninger',
  'sync-ejf-administrator',
] as const;

/**
 * Per-kald timeout. 3 × 95s = 285s < maxDuration (300s), så orchestratoren
 * selv aldrig timer ud. Sub-routen fortsætter server-side efter en abort.
 */
const PER_JOB_TIMEOUT_MS = 95_000;

/**
 * Verificerer at anmodningen er autoriseret via CRON_SECRET.
 * I production kræves desuden Vercels interne x-vercel-cron header.
 *
 * @param request - Indgående Next.js request
 * @returns true hvis autoriseret, ellers false
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
 * GET /api/cron/sync-ejf-all
 *
 * Fyrer de tre EJF-delta-sync-routes sekventielt på samme deployment-origin.
 *
 * Kræver:
 *   - Authorization: Bearer <CRON_SECRET>
 *   - x-vercel-cron: 1 (kun i production)
 *
 * @param request - Indgående Next.js request med Authorization header
 * @returns JSON-respons med per-sub-job status (HTTP-status eller timeout/fejl)
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'sync-ejf-all', schedule: '0 5 * * *', intervalMinutes: 1440 },
    async () => {
      const origin = request.nextUrl.origin;
      const secret = process.env.CRON_SECRET ?? '';
      const results: Record<string, string> = {};

      for (const job of SUB_JOBS) {
        try {
          const res = await fetch(`${origin}/api/cron/${job}`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${secret}`,
              'x-vercel-cron': '1',
            },
            signal: AbortSignal.timeout(PER_JOB_TIMEOUT_MS),
          });
          results[job] = `HTTP ${res.status}`;
        } catch (err) {
          // Timeout/abort er forventeligt under backfill — sub-routen kører
          // videre server-side og gemmer cursor. Vi logger blot udfaldet.
          const reason = err instanceof Error ? err.name : 'unknown';
          results[job] = `dispatched (klient-timeout: ${reason})`;
          logger.warn(`[sync-ejf-all] ${job} klient-timeout/fejl: ${reason}`);
        }
      }

      return NextResponse.json({ ok: true, dispatched: SUB_JOBS.length, results });
    }
  );
}
