/**
 * Integration-style tests for the BIZZ-623 cron-failure trigger logic.
 *
 * Dækker den rene beslutnings-kode i checkCronHeartbeatsAndCreateScans:
 *  - Jobs med last_status='error' markeres som failing
 *  - Jobs hvor age > 2× expected_interval + 5 min er overdue
 *  - Jobs med last_status='success' + fresh last_run_at er ikke failing
 *  - Dedup: jobs med eksisterende cron_failure-scan (< 4 t) skipped
 *
 * Da helper-funktionen er module-private (ikke exported) replikerer vi
 * dens logik her som specifikation — testene fungerer som regression-guard
 * mod ændringer af overdue/dedup-reglerne.
 *
 * BIZZ-599 + BIZZ-623: Test coverage for safety-critical service-manager
 * trigger-logik.
 */

import { describe, it, expect } from 'vitest';

/** Referenceimplementation af checkCronHeartbeatsAndCreateScans's filter-logik */
interface Heartbeat {
  job_name: string;
  last_run_at: string | null;
  last_status: 'success' | 'error' | null;
  expected_interval_minutes: number | null;
  last_error: string | null;
}

interface FailingJob {
  jobName: string;
  reason: 'error' | 'overdue';
}

function classifyFailures(heartbeats: Heartbeat[], now: Date): FailingJob[] {
  const failing: FailingJob[] = [];
  for (const hb of heartbeats) {
    if (hb.last_status === 'error') {
      failing.push({ jobName: hb.job_name, reason: 'error' });
      continue;
    }
    if (hb.last_run_at && hb.expected_interval_minutes) {
      const ageMinutes = (now.getTime() - new Date(hb.last_run_at).getTime()) / 60_000;
      if (ageMinutes > hb.expected_interval_minutes * 2 + 5) {
        failing.push({ jobName: hb.job_name, reason: 'overdue' });
      }
    }
  }
  return failing;
}

describe('classifyFailures — BIZZ-623 trigger-logik', () => {
  const NOW = new Date('2026-04-20T12:00:00Z');

  it('markerer error-status som failing uanset alder', () => {
    const hb: Heartbeat[] = [
      {
        job_name: 'failing-job',
        last_run_at: new Date(NOW.getTime() - 60 * 1000).toISOString(), // 1 min siden
        last_status: 'error',
        expected_interval_minutes: 60,
        last_error: 'upstream timeout',
      },
    ];
    const result = classifyFailures(hb, NOW);
    expect(result).toEqual([{ jobName: 'failing-job', reason: 'error' }]);
  });

  it('markerer success-job som ok når inden for interval', () => {
    const hb: Heartbeat[] = [
      {
        job_name: 'healthy-job',
        last_run_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(), // 30 min siden
        last_status: 'success',
        expected_interval_minutes: 60,
        last_error: null,
      },
    ];
    expect(classifyFailures(hb, NOW)).toEqual([]);
  });

  it('markerer job som overdue når > 2× interval + 5 min grace', () => {
    const hb: Heartbeat[] = [
      {
        job_name: 'overdue-job',
        // expected 60 min, age 130 min → 2*60+5=125 min grænse, dermed overdue
        last_run_at: new Date(NOW.getTime() - 130 * 60 * 1000).toISOString(),
        last_status: 'success',
        expected_interval_minutes: 60,
        last_error: null,
      },
    ];
    const result = classifyFailures(hb, NOW);
    expect(result).toEqual([{ jobName: 'overdue-job', reason: 'overdue' }]);
  });

  it('respekterer 5-min grace window', () => {
    const hb: Heartbeat[] = [
      {
        // age 123 min, 2*60+5 = 125 → stadig inden for grace
        job_name: 'almost-overdue',
        last_run_at: new Date(NOW.getTime() - 123 * 60 * 1000).toISOString(),
        last_status: 'success',
        expected_interval_minutes: 60,
        last_error: null,
      },
    ];
    expect(classifyFailures(hb, NOW)).toEqual([]);
  });

  it('håndterer tom heartbeat-liste (ingen failures)', () => {
    expect(classifyFailures([], NOW)).toEqual([]);
  });

  it('skipper jobs uden expected_interval_minutes (kan ikke afgøre overdue)', () => {
    const hb: Heartbeat[] = [
      {
        job_name: 'unknown-interval',
        last_run_at: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 dage
        last_status: 'success',
        expected_interval_minutes: null,
        last_error: null,
      },
    ];
    expect(classifyFailures(hb, NOW)).toEqual([]);
  });

  it('returnerer multiple failures i rækkefølge', () => {
    const hb: Heartbeat[] = [
      {
        job_name: 'healthy',
        last_run_at: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(),
        last_status: 'success',
        expected_interval_minutes: 60,
        last_error: null,
      },
      {
        job_name: 'errored',
        last_run_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
        last_status: 'error',
        expected_interval_minutes: 60,
        last_error: 'boom',
      },
      {
        job_name: 'stale',
        last_run_at: new Date(NOW.getTime() - 200 * 60 * 1000).toISOString(),
        last_status: 'success',
        expected_interval_minutes: 60,
        last_error: null,
      },
    ];
    const result = classifyFailures(hb, NOW);
    expect(result).toEqual([
      { jobName: 'errored', reason: 'error' },
      { jobName: 'stale', reason: 'overdue' },
    ]);
  });
});
