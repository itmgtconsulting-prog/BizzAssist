/**
 * BIZZ-2237: Unit-tests for service-scan drift-checks (heartbeat + freshness).
 *
 * Verificerer at runScan's nye grene omsætter cron_heartbeats + data_sync_status/
 * DATA_SOURCES-tilstand til korrekte ScanIssues, så Service Manager fanger overdue
 * crons, silent no-ops og forældede datakilder (ikke kun Vercel-builds).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock de underliggende infra-kald + registry-opslag.
vi.mock('@/app/lib/cronHeartbeat', () => ({ checkHeartbeats: vi.fn() }));
vi.mock('@/app/lib/dataFreshness', () => ({ checkAllDataFreshness: vi.fn() }));
vi.mock('@/app/lib/cron/registry', () => ({ getCronJob: vi.fn() }));

import { checkHeartbeats } from '@/app/lib/cronHeartbeat';
import { checkAllDataFreshness } from '@/app/lib/dataFreshness';
import { getCronJob } from '@/app/lib/cron/registry';
import {
  checkCronHeartbeatIssues,
  checkDataFreshnessIssues,
} from '@/app/api/cron/service-scan/route';

const mockHb = vi.mocked(checkHeartbeats);
const mockFresh = vi.mocked(checkAllDataFreshness);
const mockJob = vi.mocked(getCronJob);

function hb(over: Record<string, unknown>) {
  return {
    job_name: 'x',
    last_run_at: '2026-09-05T00:00:00Z',
    last_status: 'success',
    last_duration_ms: 10,
    expected_interval_minutes: 60,
    last_error: null,
    last_items_processed: 5,
    last_items_written: 5,
    last_degraded_reason: null,
    updated_at: '2026-09-05T00:00:00Z',
    is_overdue: false,
    minutes_overdue: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockJob.mockReturnValue(undefined as never);
});

describe('BIZZ-2237 checkCronHeartbeatIssues', () => {
  it('flager overdue job som error', async () => {
    mockHb.mockResolvedValue([
      hb({ job_name: 'sync', is_overdue: true, minutes_overdue: 180 }),
    ] as never);
    const issues = await checkCronHeartbeatIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      type: 'cron_overdue',
      severity: 'error',
      source: 'cron_heartbeat',
    });
    expect(issues[0].message).toContain('180');
  });

  it('flager failed heartbeat som error', async () => {
    mockHb.mockResolvedValue([hb({ last_status: 'error', last_error: 'boom' })] as never);
    const issues = await checkCronHeartbeatIssues();
    expect(issues[0]).toMatchObject({ type: 'cron_degraded', severity: 'error' });
    expect(issues[0].context).toBe('boom');
  });

  it('flager eksplicit degraded som warning', async () => {
    mockHb.mockResolvedValue([
      hb({ last_status: 'degraded', last_degraded_reason: 'kilde tom' }),
    ] as never);
    const issues = await checkCronHeartbeatIssues();
    expect(issues[0]).toMatchObject({ type: 'cron_degraded', severity: 'warning' });
    expect(issues[0].context).toBe('kilde tom');
  });

  it('fanger silent no-op: expectsWork + success + 0 items', async () => {
    mockJob.mockReturnValue({ expectsWork: true, description: 'd' } as never);
    mockHb.mockResolvedValue([hb({ last_status: 'success', last_items_processed: 0 })] as never);
    const issues = await checkCronHeartbeatIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ type: 'cron_degraded', severity: 'warning' });
  });

  it('sund success uden expectsWork giver ingen issue', async () => {
    mockJob.mockReturnValue({ expectsWork: false } as never);
    mockHb.mockResolvedValue([hb({ last_status: 'success', last_items_processed: 0 })] as never);
    expect(await checkCronHeartbeatIssues()).toHaveLength(0);
  });
});

describe('BIZZ-2237 checkDataFreshnessIssues', () => {
  const base = {
    sourceName: 's',
    domain: 'd',
    table: 't',
    timestampColumn: 'ts',
    rowCount: 1,
    lastUpdated: '2026-09-01',
    hoursSinceUpdate: 100,
    warningThresholdHours: 48,
    criticalThresholdHours: 168,
    status: 'ok' as const,
  };

  it('ok datakilde giver ingen issue', async () => {
    mockFresh.mockResolvedValue([{ ...base, status: 'ok' }] as never);
    expect(await checkDataFreshnessIssues()).toHaveLength(0);
  });

  it('warning → warning-issue, critical → error-issue', async () => {
    mockFresh.mockResolvedValue([
      { ...base, sourceName: 'w', status: 'warning', hoursSinceUpdate: 60 },
      { ...base, sourceName: 'c', status: 'critical', hoursSinceUpdate: 200 },
    ] as never);
    const issues = await checkDataFreshnessIssues();
    expect(issues).toHaveLength(2);
    expect(issues.find((i) => i.message.includes("'w'"))?.severity).toBe('warning');
    expect(issues.find((i) => i.message.includes("'c'"))?.severity).toBe('error');
    expect(issues.every((i) => i.type === 'stale_data' && i.source === 'data_freshness')).toBe(
      true
    );
  });
});
