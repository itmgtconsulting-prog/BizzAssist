/**
 * Unit tests for app/lib/notifyFollowers.ts — dispatchFollowerEmails().
 *
 * Covers:
 *   - Sends an entity-change email for a pending notification and marks it sent
 *   - Looks up the follower's email via admin.auth.admin.getUserById
 *   - Uses saved_entities.label as the entity label
 *   - Skips the email when the user has no email, but STILL marks it sent
 *     (idempotency — must not retry-loop)
 *   - Does nothing when there are no pending notifications
 *
 * Supabase admin client, tenantDb and sendEntityChangeEmail are all mocked —
 * no real DB or HTTP calls are made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('@/app/lib/email', () => ({
  sendEntityChangeEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
  tenantDb: vi.fn(),
}));

import { dispatchFollowerEmails } from '@/app/lib/notifyFollowers';
import { sendEntityChangeEmail } from '@/app/lib/email';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';

/** A chainable tenant-DB builder mock that mirrors the PostgREST query shapes used. */
function makeTenantDb(opts: {
  pending: Record<string, unknown>[];
  label: string | null;
  updateSpy: (vals: Record<string, unknown>) => void;
}) {
  return {
    from(table: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        _isUpdate: false,
        select: () => builder,
        update: (vals: Record<string, unknown>) => {
          builder._isUpdate = true;
          opts.updateSpy(vals);
          return builder;
        },
        is: () => builder,
        order: () => builder,
        eq: () => (builder._isUpdate ? Promise.resolve({ data: null, error: null }) : builder),
        limit: () =>
          table === 'notifications' ? Promise.resolve({ data: opts.pending }) : builder,
        maybeSingle: () => Promise.resolve({ data: opts.label ? { label: opts.label } : null }),
      };
      return builder;
    },
  };
}

/** Build a mock admin client returning one tenant + a user-email lookup table. */
function makeAdmin(emailById: Record<string, string | null>) {
  return {
    from: () => ({
      select: () =>
        Promise.resolve({ data: [{ id: 't1', schema_name: 'tenant_t1' }], error: null }),
    }),
    auth: {
      admin: {
        getUserById: vi.fn(async (id: string) => ({
          data: { user: emailById[id] ? { email: emailById[id] } : null },
        })),
      },
    },
  };
}

const pendingNotification = {
  id: 'n1',
  user_id: 'u1',
  entity_id: 'bfe-123',
  entity_type: 'property',
  title: 'Ejerskifte registreret',
  message: 'Ejerskifte registreret på Testvej 1',
  created_at: '2026-06-22T10:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatchFollowerEmails', () => {
  it('sends an email for a pending notification and marks it as sent', async () => {
    const updateSpy = vi.fn();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeAdmin({ u1: 'follower@example.com' })
    );
    (tenantDb as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTenantDb({
        pending: [pendingNotification],
        label: 'Testvej 1, 1000 København',
        updateSpy,
      })
    );

    const result = await dispatchFollowerEmails();

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(sendEntityChangeEmail).toHaveBeenCalledTimes(1);
    const arg = (sendEntityChangeEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.to).toBe('follower@example.com');
    expect(arg.entityType).toBe('property');
    expect(arg.entityLabel).toBe('Testvej 1, 1000 København');
    expect(arg.changeTitle).toBe('Ejerskifte registreret');
    expect(arg.link).toContain('/dashboard/ejendomme/bfe-123');
    // Marked sent (idempotency)
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toHaveProperty('email_sent_at');
  });

  it('skips the email when the user has no email but still marks it sent', async () => {
    const updateSpy = vi.fn();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(makeAdmin({ u1: null }));
    (tenantDb as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTenantDb({ pending: [pendingNotification], label: null, updateSpy })
    );

    const result = await dispatchFollowerEmails();

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sendEntityChangeEmail).not.toHaveBeenCalled();
    // Still marked sent so it is never retried
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there are no pending notifications', async () => {
    const updateSpy = vi.fn();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeAdmin({ u1: 'follower@example.com' })
    );
    (tenantDb as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTenantDb({ pending: [], label: null, updateSpy })
    );

    const result = await dispatchFollowerEmails();

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sendEntityChangeEmail).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('falls back to entity_id as label when no saved_entity is found', async () => {
    const updateSpy = vi.fn();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeAdmin({ u1: 'follower@example.com' })
    );
    (tenantDb as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTenantDb({ pending: [pendingNotification], label: null, updateSpy })
    );

    await dispatchFollowerEmails();

    const arg = (sendEntityChangeEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.entityLabel).toBe('bfe-123');
  });
});
