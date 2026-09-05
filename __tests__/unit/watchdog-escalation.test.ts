/**
 * BIZZ-2241: Unit-tests for watchdog vedvarende-overdue-eskalering.
 *
 * Verificerer: optæller på-hinanden-følgende overdue-observationer, eskalerer
 * først ved tærsklen (ikke før), nulstiller når job kommer tilbage, og dedup'er
 * via drift-broen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock drift-broen + admin-client.
vi.mock('@/app/lib/cron/driftTicketBridge', () => ({ syncDriftTicket: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { syncDriftTicket } from '@/app/lib/cron/driftTicketBridge';
import { createAdminClient } from '@/lib/supabase/admin';
import { escalatePersistentOverdue } from '@/app/api/cron/watchdog/route';

const mockSync = vi.mocked(syncDriftTicket);
const mockAdmin = vi.mocked(createAdminClient);

/** Fake admin der returnerer given state-JSON og opsamler upsert. */
function fakeAdmin(stateJson: string | null) {
  const upserts: Record<string, unknown>[] = [];
  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: stateJson === null ? null : { last_error: stateJson },
            }),
          }),
        }),
        upsert: (row: Record<string, unknown>) => {
          upserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, upserts };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSync.mockResolvedValue({ action: 'created', jiraKey: 'BIZZ-1', label: 'drift-x' });
});

describe('BIZZ-2241 escalatePersistentOverdue', () => {
  it('optæller uden at eskalere før tærsklen (3)', async () => {
    const { client, upserts } = fakeAdmin(null); // ingen tidligere state → count bliver 1
    mockAdmin.mockReturnValue(client as never);
    const n = await escalatePersistentOverdue([{ jobName: 'sync', detail: 'overdue 40m' }]);
    expect(n).toBe(0);
    expect(mockSync).not.toHaveBeenCalled();
    expect(JSON.parse(upserts[0].last_error as string)).toEqual({ sync: 1 });
  });

  it('eskalerer når 3. på-hinanden-følgende observation nås', async () => {
    const { client } = fakeAdmin(JSON.stringify({ sync: 2 })); // prev=2 → nu 3
    mockAdmin.mockReturnValue(client as never);
    const n = await escalatePersistentOverdue([{ jobName: 'sync', detail: 'overdue 100m' }]);
    expect(n).toBe(1);
    expect(mockSync).toHaveBeenCalledTimes(1);
    const arg = mockSync.mock.calls[0][0];
    expect(arg).toMatchObject({ type: 'cron_overdue', source: 'cron_heartbeat', dedupKey: 'sync' });
  });

  it('nulstiller job der er kommet tilbage (ikke længere overdue)', async () => {
    const { client, upserts } = fakeAdmin(JSON.stringify({ sync: 5, other: 1 }));
    mockAdmin.mockReturnValue(client as never);
    // kun 'other' er overdue nu → 'sync' droppes fra state
    const n = await escalatePersistentOverdue([{ jobName: 'other', detail: 'overdue' }]);
    expect(n).toBe(0); // other=2, under tærskel
    const state = JSON.parse(upserts[0].last_error as string);
    expect(state).toEqual({ other: 2 });
    expect(state.sync).toBeUndefined();
  });

  it('tom overdue-liste nulstiller al state', async () => {
    const { client, upserts } = fakeAdmin(JSON.stringify({ sync: 4 }));
    mockAdmin.mockReturnValue(client as never);
    const n = await escalatePersistentOverdue([]);
    expect(n).toBe(0);
    expect(JSON.parse(upserts[0].last_error as string)).toEqual({});
  });

  it('deduped ticket tæller ikke som ny (n=0)', async () => {
    mockSync.mockResolvedValue({ action: 'deduped', jiraKey: 'BIZZ-9', label: 'drift-x' });
    const { client } = fakeAdmin(JSON.stringify({ sync: 9 }));
    mockAdmin.mockReturnValue(client as never);
    const n = await escalatePersistentOverdue([{ jobName: 'sync', detail: 'overdue' }]);
    expect(mockSync).toHaveBeenCalledTimes(1); // forsøgte
    expect(n).toBe(0); // men allerede åben ticket → ingen ny
  });
});
