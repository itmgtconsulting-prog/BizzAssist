/**
 * Unit tests for BIZZ-611 EJF ingest health monitoring.
 *
 * The actual helper is a private function inside service-scan route. These
 * tests verify the pure decision logic by simulating the two detection cases
 * (stuck run, low volume) in isolation — they don't boot the full cron.
 */

import { describe, it, expect } from 'vitest';

interface IngestRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  rows_processed: number | null;
  error: string | null;
}

/**
 * Pure detection logic extracted from service-scan. Kept in sync with
 * checkEjfIngestHealthAndCreateScans() — the inline inserts + dedup live
 * in the cron route and are integration-tested.
 */
function detectEjfIngestIssues(
  recentRuns: IngestRow[],
  now: Date
): Array<{ reason: 'stuck' | 'low_volume'; detail: string }> {
  const issues: Array<{ reason: 'stuck' | 'low_volume'; detail: string }> = [];
  if (recentRuns.length === 0) return issues;

  const latest = recentRuns[0];
  if (!latest.finished_at) {
    const ageHours = (now.getTime() - new Date(latest.started_at).getTime()) / 3_600_000;
    if (ageHours > 24) {
      issues.push({
        reason: 'stuck',
        detail: `ingest_run id=${latest.id} startede for ${ageHours.toFixed(1)} t siden og er ikke afsluttet`,
      });
    }
  }

  const latestSuccess = recentRuns.find((r) => r.finished_at && !r.error);
  if (latestSuccess && (latestSuccess.rows_processed ?? 0) < 100) {
    issues.push({
      reason: 'low_volume',
      detail: `ingest_run id=${latestSuccess.id} processede kun ${latestSuccess.rows_processed ?? 0} rækker`,
    });
  }

  return issues;
}

const NOW = new Date('2026-04-20T18:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('detectEjfIngestIssues — BIZZ-611', () => {
  it('returns no issues for empty input', () => {
    expect(detectEjfIngestIssues([], NOW)).toEqual([]);
  });

  it('flags stuck run when finished_at=NULL and age > 24h', () => {
    const runs: IngestRow[] = [
      {
        id: 42,
        started_at: hoursAgo(30),
        finished_at: null,
        rows_processed: null,
        error: null,
      },
    ];
    const result = detectEjfIngestIssues(runs, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('stuck');
    expect(result[0].detail).toContain('id=42');
  });

  it('does NOT flag stuck run when finished_at=NULL but age < 24h', () => {
    const runs: IngestRow[] = [
      {
        id: 7,
        started_at: hoursAgo(6),
        finished_at: null,
        rows_processed: null,
        error: null,
      },
    ];
    expect(detectEjfIngestIssues(runs, NOW)).toEqual([]);
  });

  it('flags low volume when latest success processed < 100 rows', () => {
    const runs: IngestRow[] = [
      {
        id: 9,
        started_at: hoursAgo(2),
        finished_at: hoursAgo(1),
        rows_processed: 12,
        error: null,
      },
    ];
    const result = detectEjfIngestIssues(runs, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('low_volume');
    expect(result[0].detail).toContain('12 rækker');
  });

  it('does NOT flag low volume when rows_processed >= 100', () => {
    const runs: IngestRow[] = [
      {
        id: 11,
        started_at: hoursAgo(6),
        finished_at: hoursAgo(5),
        rows_processed: 1_234_567,
        error: null,
      },
    ];
    expect(detectEjfIngestIssues(runs, NOW)).toEqual([]);
  });

  it('does NOT flag low volume when the run had an error (use prior success)', () => {
    const runs: IngestRow[] = [
      {
        id: 20,
        started_at: hoursAgo(2),
        finished_at: hoursAgo(1),
        rows_processed: 5,
        error: 'OOM',
      },
      {
        id: 19,
        started_at: hoursAgo(26),
        finished_at: hoursAgo(25),
        rows_processed: 2_000_000,
        error: null,
      },
    ];
    // Latest success is id=19 with 2M rows — no low-volume flag.
    expect(detectEjfIngestIssues(runs, NOW)).toEqual([]);
  });

  it('can surface both stuck and low-volume flags in one pass', () => {
    const runs: IngestRow[] = [
      {
        // stuck — latest, still running 30h later
        id: 30,
        started_at: hoursAgo(30),
        finished_at: null,
        rows_processed: null,
        error: null,
      },
      {
        // low-volume — latest successful completed
        id: 29,
        started_at: hoursAgo(54),
        finished_at: hoursAgo(53),
        rows_processed: 17,
        error: null,
      },
    ];
    const result = detectEjfIngestIssues(runs, NOW);
    expect(result).toHaveLength(2);
    const reasons = result.map((r) => r.reason).sort();
    expect(reasons).toEqual(['low_volume', 'stuck']);
  });

  it('treats null rows_processed as 0 (triggers low volume)', () => {
    const runs: IngestRow[] = [
      {
        id: 50,
        started_at: hoursAgo(6),
        finished_at: hoursAgo(5),
        rows_processed: null,
        error: null,
      },
    ];
    const result = detectEjfIngestIssues(runs, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('low_volume');
  });
});
