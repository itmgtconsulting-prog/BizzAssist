/**
 * Unit tests for lib/api/auth.ts — resolveTenantId + resolveUserId helpers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the supabase server client factory
const mockFrom = vi.fn();
const mockGetUser = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

import { resolveTenantId, resolveUserId } from '@/lib/api/auth';

function mockMembershipChain(data: unknown) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data }),
  };
  mockFrom.mockReturnValue(chain);
  return chain;
}

describe('resolveTenantId', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockFrom.mockReset();
  });

  it('returns null when no authenticated user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await resolveTenantId()).toBeNull();
  });

  it('returns null when user has no tenant_membership', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    mockMembershipChain(null);
    expect(await resolveTenantId()).toBeNull();
  });

  it('returns null when membership row has no tenant_id', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    mockMembershipChain({ tenant_id: null });
    expect(await resolveTenantId()).toBeNull();
  });

  it('returns {tenantId, userId} when authenticated with tenant', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } } });
    mockMembershipChain({ tenant_id: 'tenant-456' });
    expect(await resolveTenantId()).toEqual({
      tenantId: 'tenant-456',
      userId: 'user-123',
    });
  });

  it('returns null when supabase throws', async () => {
    mockGetUser.mockRejectedValue(new Error('session broken'));
    expect(await resolveTenantId()).toBeNull();
  });
});

describe('resolveUserId', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
  });

  it('returns userId when authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    expect(await resolveUserId()).toBe('u1');
  });

  it('returns null when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await resolveUserId()).toBeNull();
  });

  it('returns null when supabase throws', async () => {
    mockGetUser.mockRejectedValue(new Error('session fetch failed'));
    expect(await resolveUserId()).toBeNull();
  });
});
