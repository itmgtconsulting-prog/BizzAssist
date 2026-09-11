/**
 * BIZZ-2240: Unit-tests for auto-ticketing-broen (drift → JIRA, dedupliceret).
 *
 * Verificerer stabil signatur-label, dedup mod aabne tickets (ingen board-spam),
 * oprettelse naar ingen aaben findes, kilde-filtrering + cap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  driftSignatureLabel,
  syncDriftTicket,
  syncDriftTickets,
  type DriftIssue,
} from '@/app/lib/cron/driftTicketBridge';

const ENV = {
  JIRA_BASE_URL: 'https://jira.test',
  JIRA_PROJECT_KEY: 'BIZZ',
  JIRA_API_TOKEN: 'tok',
  JIRA_USER_EMAIL: 'a@b.dk',
};

function issue(over: Partial<DriftIssue> = {}): DriftIssue {
  return {
    type: 'cron_overdue',
    severity: 'error',
    message: "Cron 'sync' er overdue",
    source: 'cron_heartbeat',
    dedupKey: 'sync',
    ...over,
  };
}

beforeEach(() => {
  Object.assign(process.env, ENV);
  vi.restoreAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('BIZZ-2240 driftSignatureLabel', () => {
  it('er stabil for samme issue-identitet', () => {
    expect(driftSignatureLabel(issue())).toBe(
      driftSignatureLabel(issue({ message: 'anden tekst' }))
    );
  });
  it('adskiller på dedupKey', () => {
    expect(driftSignatureLabel(issue({ dedupKey: 'a' }))).not.toBe(
      driftSignatureLabel(issue({ dedupKey: 'b' }))
    );
  });
  it('adskiller på type', () => {
    expect(driftSignatureLabel(issue({ type: 'cron_overdue' }))).not.toBe(
      driftSignatureLabel(issue({ type: 'cron_degraded' }))
    );
  });
});

describe('BIZZ-2240 syncDriftTicket', () => {
  it('dedup: springer over hvis aaben ticket findes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ issues: [{ key: 'BIZZ-999' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await syncDriftTicket(issue());
    expect(r.action).toBe('deduped');
    expect(r.jiraKey).toBe('BIZZ-999');
    expect(fetchMock).toHaveBeenCalledTimes(1); // kun søgning, ingen POST
  });

  it('opretter ticket når ingen aaben findes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ issues: [] }) }) // søgning
      .mockResolvedValueOnce({ ok: true, json: async () => ({ key: 'BIZZ-1000' }) }); // create
    vi.stubGlobal('fetch', fetchMock);
    const r = await syncDriftTicket(issue());
    expect(r.action).toBe('created');
    expect(r.jiraKey).toBe('BIZZ-1000');
    // create-kaldet skal have signatur-label + drift-auto
    const postBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(postBody.fields.labels).toContain('drift-auto');
    expect(postBody.fields.labels).toContain(driftSignatureLabel(issue()));
  });

  it('skipper når JIRA-env mangler', async () => {
    delete process.env.JIRA_BASE_URL;
    const r = await syncDriftTicket(issue());
    expect(r.action).toBe('skipped');
  });
});

describe('BIZZ-2240 syncDriftTickets', () => {
  it('filtrerer på drift-kilder + error-severity og capper', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ issues: [] }) });
    // create-svar for hvert POST
    fetchMock.mockImplementation(async (_url: string, opts?: { method?: string }) =>
      opts?.method === 'POST'
        ? { ok: true, json: async () => ({ key: 'BIZZ-X' }) }
        : { ok: true, json: async () => ({ issues: [] }) }
    );
    vi.stubGlobal('fetch', fetchMock);
    const issues: DriftIssue[] = [
      issue({ dedupKey: 'a' }),
      issue({ dedupKey: 'b', source: 'data_freshness', type: 'stale_data' }),
      issue({ severity: 'warning', dedupKey: 'c' }), // filtreres væk (warning)
      { type: 'build_error', severity: 'error', message: 'x', source: 'vercel_build' }, // ikke drift-kilde
    ];
    const results = await syncDriftTickets(issues, 5);
    expect(results).toHaveLength(2); // kun de 2 error-drift-issues
    expect(results.every((r) => r.action === 'created')).toBe(true);
  });

  it('respekterer cap', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, opts?: { method?: string }) =>
        opts?.method === 'POST'
          ? { ok: true, json: async () => ({ key: 'BIZZ-X' }) }
          : { ok: true, json: async () => ({ issues: [] }) }
      );
    vi.stubGlobal('fetch', fetchMock);
    const many = Array.from({ length: 10 }, (_, i) => issue({ dedupKey: `job${i}` }));
    const results = await syncDriftTickets(many, 3);
    expect(results.filter((r) => r.action === 'created')).toHaveLength(3);
  });
});
