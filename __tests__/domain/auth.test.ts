/**
 * BIZZ-700 tests — domain auth helpers.
 *
 * Verifies resolveDomainId / assertDomainAdmin / assertDomainMember behaviour
 * against the membership table and the UUID-validation guard (BIZZ-722 Lag 3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}));

import { resolveDomainId, assertDomainAdmin, assertDomainMember } from '@/app/lib/domainAuth';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const VALID_DOMAIN_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_USER_UUID = '22222222-2222-4222-8222-222222222222';

/**
 * Builds a mocked server client + admin client for a given membership scenario.
 */
function mockClients(opts: {
  user: { id: string } | null;
  membership: { role: 'admin' | 'member' } | null;
}) {
  const getUser = vi.fn().mockResolvedValue({ data: { user: opts.user } });
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser },
  } as unknown as Awaited<ReturnType<typeof createClient>>);

  const maybeSingle = vi.fn().mockResolvedValue({ data: opts.membership, error: null });
  const eq2 = vi.fn().mockReturnValue({ maybeSingle });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ select });

  vi.mocked(createAdminClient).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof createAdminClient>);

  return { from, select };
}

describe('resolveDomainId — BIZZ-700 + BIZZ-722 Lag 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when domainId is not a valid UUID (injection guard)', async () => {
    const { from } = mockClients({
      user: { id: VALID_USER_UUID },
      membership: { role: 'admin' },
    });
    const ctx = await resolveDomainId("' OR 1=1 --");
    expect(ctx).toBeNull();
    // BIZZ-722 Lag 3: must NOT hit the DB on invalid input
    expect(from).not.toHaveBeenCalled();
  });

  it('returns null when user is unauthenticated', async () => {
    mockClients({ user: null, membership: null });
    const ctx = await resolveDomainId(VALID_DOMAIN_UUID);
    expect(ctx).toBeNull();
  });

  it('returns null when user is authenticated but not a member', async () => {
    mockClients({ user: { id: VALID_USER_UUID }, membership: null });
    const ctx = await resolveDomainId(VALID_DOMAIN_UUID);
    expect(ctx).toBeNull();
  });

  it('returns DomainContext with role=member for a plain member', async () => {
    mockClients({
      user: { id: VALID_USER_UUID },
      membership: { role: 'member' },
    });
    const ctx = await resolveDomainId(VALID_DOMAIN_UUID);
    expect(ctx).toEqual({
      domainId: VALID_DOMAIN_UUID,
      role: 'member',
      userId: VALID_USER_UUID,
    });
  });

  it('returns DomainContext with role=admin for a domain admin', async () => {
    mockClients({
      user: { id: VALID_USER_UUID },
      membership: { role: 'admin' },
    });
    const ctx = await resolveDomainId(VALID_DOMAIN_UUID);
    expect(ctx?.role).toBe('admin');
  });
});

describe('assertDomainAdmin — BIZZ-700', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws Forbidden when user is not a member', async () => {
    mockClients({ user: { id: VALID_USER_UUID }, membership: null });
    await expect(assertDomainAdmin(VALID_DOMAIN_UUID)).rejects.toThrow('Forbidden');
  });

  it('throws Forbidden when user is a member but not admin', async () => {
    mockClients({
      user: { id: VALID_USER_UUID },
      membership: { role: 'member' },
    });
    await expect(assertDomainAdmin(VALID_DOMAIN_UUID)).rejects.toThrow('Forbidden');
  });

  it('returns DomainContext when user is admin', async () => {
    mockClients({
      user: { id: VALID_USER_UUID },
      membership: { role: 'admin' },
    });
    const ctx = await assertDomainAdmin(VALID_DOMAIN_UUID);
    expect(ctx.role).toBe('admin');
  });
});

describe('assertDomainMember — BIZZ-700', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws Forbidden for non-members', async () => {
    mockClients({ user: { id: VALID_USER_UUID }, membership: null });
    await expect(assertDomainMember(VALID_DOMAIN_UUID)).rejects.toThrow('Forbidden');
  });

  it('accepts both admin and member roles', async () => {
    mockClients({
      user: { id: VALID_USER_UUID },
      membership: { role: 'member' },
    });
    const memberCtx = await assertDomainMember(VALID_DOMAIN_UUID);
    expect(memberCtx.role).toBe('member');

    mockClients({
      user: { id: VALID_USER_UUID },
      membership: { role: 'admin' },
    });
    const adminCtx = await assertDomainMember(VALID_DOMAIN_UUID);
    expect(adminCtx.role).toBe('admin');
  });

  it('rejects malformed UUIDs without touching the DB', async () => {
    const { from } = mockClients({
      user: { id: VALID_USER_UUID },
      membership: { role: 'admin' },
    });
    await expect(assertDomainMember('not-a-uuid')).rejects.toThrow('Forbidden');
    expect(from).not.toHaveBeenCalled();
  });
});
