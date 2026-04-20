/**
 * Unit-tests for withCronMonitor — shared observability wrapper for alle cron-
 * routes (BIZZ-621 + BIZZ-624).
 *
 * Dækker:
 *  - Heartbeat kaldes med success + duration ved OK-handler
 *  - Heartbeat kaldes med error + fejlmeddelelse ved exception
 *  - Sentry.withMonitor modtager job-name + schedule + interval
 *  - Handler-svar bubbler korrekt tilbage
 *  - Exception fra handler re-throwes så Sentry markerer check-in som error
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';

// Mocks skal hoistes FØR import af modulet under test så vi rammer vi.mock-
// replacement i stedet for de rigtige implementationer.
vi.mock('@sentry/nextjs', () => ({
  withMonitor: vi.fn((_name: string, fn: () => unknown) => {
    // Kør handleren direkte — Sentry-wrapperen er transparent i prod.
    return fn();
  }),
}));

vi.mock('@/app/lib/cronHeartbeat', () => ({
  recordHeartbeat: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/app/lib/logger', () => ({
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as Sentry from '@sentry/nextjs';
import { recordHeartbeat } from '@/app/lib/cronHeartbeat';
import { withCronMonitor } from '@/app/lib/cronMonitor';

describe('withCronMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returnerer NextResponse fra handleren uændret ved success', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const res = await withCronMonitor(
      { jobName: 'test-job', schedule: '0 * * * *', intervalMinutes: 60 },
      handler
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('kalder recordHeartbeat med status=success og duration efter OK-handler', async () => {
    await withCronMonitor(
      { jobName: 'daily-report', schedule: '0 7 * * *', intervalMinutes: 1440 },
      async () => NextResponse.json({ ok: true })
    );
    expect(recordHeartbeat).toHaveBeenCalledTimes(1);
    const call = (recordHeartbeat as unknown as Mock).mock.calls[0];
    expect(call[0]).toBe('daily-report');
    expect(call[1]).toBe('success');
    expect(typeof call[2]).toBe('number'); // durationMs
    expect(call[2]).toBeGreaterThanOrEqual(0);
    expect(call[3]).toBe(1440); // intervalMinutes
  });

  it('kalder recordHeartbeat med status=error + fejlmeddelelse når handler kaster', async () => {
    const handler = vi.fn(async () => {
      throw new Error('upstream timeout');
    });
    await expect(
      withCronMonitor(
        { jobName: 'failing-job', schedule: '*/5 * * * *', intervalMinutes: 5 },
        handler
      )
    ).rejects.toThrow('upstream timeout');

    expect(recordHeartbeat).toHaveBeenCalledTimes(1);
    const call = (recordHeartbeat as unknown as Mock).mock.calls[0];
    expect(call[0]).toBe('failing-job');
    expect(call[1]).toBe('error');
    expect(call[4]).toBe('upstream timeout'); // errMessage
  });

  it('videregiver schedule + interval + maxRuntime til Sentry.withMonitor', async () => {
    await withCronMonitor(
      {
        jobName: 'monitored',
        schedule: '0 4 * * *',
        intervalMinutes: 1440,
        maxRuntimeMinutes: 20,
        checkinMargin: 2,
      },
      async () => NextResponse.json({})
    );
    expect(Sentry.withMonitor).toHaveBeenCalledTimes(1);
    const args = (Sentry.withMonitor as unknown as Mock).mock.calls[0];
    expect(args[0]).toBe('monitored');
    expect(typeof args[1]).toBe('function');
    const opts = args[2];
    expect(opts.schedule).toEqual({ type: 'crontab', value: '0 4 * * *' });
    expect(opts.maxRuntime).toBe(20);
    expect(opts.checkinMargin).toBe(2);
  });

  it('default maxRuntime=10 + checkinMargin=1 når ikke angivet', async () => {
    await withCronMonitor(
      { jobName: 'defaults', schedule: '0 * * * *', intervalMinutes: 60 },
      async () => NextResponse.json({})
    );
    const opts = (Sentry.withMonitor as unknown as Mock).mock.calls[0][2];
    expect(opts.maxRuntime).toBe(10);
    expect(opts.checkinMargin).toBe(1);
  });

  it('heartbeat + Sentry-monitor kaldes også når handler returnerer non-2xx', async () => {
    // Bemærk: en NextResponse med status 500 er stadig OK fra wrapper-
    // perspektiv — det er kun thrown exceptions der markeres som error.
    // Test-forventningen: heartbeat = success fordi handleren returnerede
    // i stedet for at kaste.
    await withCronMonitor(
      { jobName: 'five-hundred', schedule: '0 * * * *', intervalMinutes: 60 },
      async () => NextResponse.json({ err: 'upstream' }, { status: 500 })
    );
    const call = (recordHeartbeat as unknown as Mock).mock.calls[0];
    expect(call[1]).toBe('success');
  });

  it('håndterer non-Error kast (fx string) med String(err) som message', async () => {
    const handler = vi.fn(async () => {
      throw 'string-error';
    });
    await expect(
      withCronMonitor(
        { jobName: 'string-throw', schedule: '0 * * * *', intervalMinutes: 60 },
        handler
      )
    ).rejects.toBe('string-error');

    const call = (recordHeartbeat as unknown as Mock).mock.calls[0];
    expect(call[1]).toBe('error');
    expect(call[4]).toBe('string-error');
  });
});
