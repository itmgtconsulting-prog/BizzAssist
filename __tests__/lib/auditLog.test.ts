/**
 * Unit tests for the shared audit-log helpers (BIZZ-2293/2297).
 *
 * Verifies the fix for the silent-failure bug: writes now target the correct
 * per-tenant schema (`tenant_<x>.audit_log`) for tenant events and
 * `public.system_audit_log` for system events, and insert errors are logged
 * (never thrown).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── next/server after() mock ────────────────────────────────────────────────
// The helpers register their write with after() so Vercel keeps the serverless
// invocation alive past the response. The write promise is started eagerly and
// returned, so tests just await the helper; after() is a no-op here.
vi.mock('next/server', () => ({ after: (fn: () => unknown) => void fn() }));

// ── Supabase admin + tenantDb mocks ─────────────────────────────────────────

/** Insert spy for the per-tenant audit_log (via tenantDb). */
const mockAuditInsert = vi.fn().mockResolvedValue({ error: null });
/** Insert spy for public.system_audit_log (via admin client). */
const mockSystemInsert = vi.fn().mockResolvedValue({ error: null });
/** tenants lookup: from('tenants').select().eq().maybeSingle() */
const mockTenantsMaybeSingle = vi
  .fn()
  .mockResolvedValue({ data: { schema_name: 'tenant_test' }, error: null });
/** memberships lookup: from('tenant_memberships').select().eq().order().limit().maybeSingle() */
const mockMembMaybeSingle = vi
  .fn()
  .mockResolvedValue({ data: { tenant_id: 'tenant-from-user' }, error: null });

/** admin.from(table) router mirroring the chains the helper uses. */
const mockAdminFrom = vi.fn((table: string) => {
  if (table === 'tenants') {
    return { select: () => ({ eq: () => ({ maybeSingle: mockTenantsMaybeSingle }) }) };
  }
  if (table === 'tenant_memberships') {
    return {
      select: () => ({
        eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: mockMembMaybeSingle }) }) }),
      }),
    };
  }
  if (table === 'system_audit_log') {
    return { insert: mockSystemInsert };
  }
  throw new Error(`unexpected table ${table}`);
});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ from: mockAdminFrom })),
  tenantDb: vi.fn(() => ({ from: () => ({ insert: mockAuditInsert }) })),
}));

// ── Server client (session user resolution) mock ────────────────────────────

const mockGetUser = vi.fn().mockResolvedValue({ data: { user: { id: 'session-user' } } });
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

// ── Logger mock ─────────────────────────────────────────────────────────────

const mockLoggerError = vi.fn();
vi.mock('@/app/lib/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => args,
    info: (...args: unknown[]) => args,
  },
}));

import { writeAuditLog, writeAuditLogByUser, writeSystemAuditLog } from '@/app/lib/auditLog';

describe('auditLog helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditInsert.mockResolvedValue({ error: null });
    mockSystemInsert.mockResolvedValue({ error: null });
    mockTenantsMaybeSingle.mockResolvedValue({ data: { schema_name: 'tenant_test' }, error: null });
    mockMembMaybeSingle.mockResolvedValue({ data: { tenant_id: 'tenant-from-user' }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: { id: 'session-user' } } });
  });

  describe('writeAuditLog', () => {
    it('writes to the tenant schema with parsed metadata and session user', async () => {
      await writeAuditLog('tenant-uuid', {
        action: 'recent_entity.upsert',
        resource_type: 'company',
        resource_id: 'cvr-123',
        metadata: JSON.stringify({ foo: 'bar' }),
      });

      expect(mockAuditInsert).toHaveBeenCalledTimes(1);
      expect(mockAuditInsert).toHaveBeenCalledWith({
        tenant_id: 'tenant-uuid',
        user_id: 'session-user',
        action: 'recent_entity.upsert',
        resource_type: 'company',
        resource_id: 'cvr-123',
        metadata: { foo: 'bar' },
      });
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it('uses an explicitly supplied userId and skips the session lookup', async () => {
      await writeAuditLog(
        'tenant-uuid',
        { action: 'x.y', resource_type: 'r', resource_id: 'id' },
        'explicit-user'
      );

      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockAuditInsert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'explicit-user', metadata: null })
      );
    });

    it('does not insert and logs when the tenant schema cannot be resolved', async () => {
      mockTenantsMaybeSingle.mockResolvedValue({ data: null, error: null });

      await writeAuditLog('ghost-tenant', {
        action: 'x.y',
        resource_type: 'r',
        resource_id: 'id',
      });

      expect(mockAuditInsert).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalled();
    });

    it('logs (does not throw) when the insert returns an error', async () => {
      mockAuditInsert.mockResolvedValue({ error: { message: 'boom' } });

      await expect(
        writeAuditLog('tenant-uuid', { action: 'x.y', resource_type: 'r', resource_id: 'id' })
      ).resolves.toBeUndefined();

      expect(mockLoggerError).toHaveBeenCalledWith('[AUDIT LOG FAILURE]', 'boom', 'x.y');
    });

    it('never throws when the underlying client throws', async () => {
      mockTenantsMaybeSingle.mockRejectedValue(new Error('network'));

      await expect(
        writeAuditLog('tenant-uuid', { action: 'x.y', resource_type: 'r', resource_id: 'id' })
      ).resolves.toBeUndefined();
    });
  });

  describe('writeAuditLogByUser', () => {
    it('resolves the tenant from the user and writes with that user_id', async () => {
      await writeAuditLogByUser('session-user', {
        action: 'ai_token.track',
        resource_type: 'ai_token_usage',
        resource_id: 'unknown',
      });

      expect(mockAuditInsert).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: 'tenant-from-user', user_id: 'session-user' })
      );
    });

    it('does not write when the user has no tenant membership', async () => {
      mockMembMaybeSingle.mockResolvedValue({ data: null, error: null });

      await writeAuditLogByUser('orphan-user', {
        action: 'x.y',
        resource_type: 'r',
        resource_id: 'id',
      });

      expect(mockAuditInsert).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });

  describe('writeSystemAuditLog', () => {
    it('writes to public.system_audit_log without any tenant/user', async () => {
      await writeSystemAuditLog({
        action: 'stripe.webhook_processed',
        resource_type: 'webhook',
        resource_id: 'evt_1',
        metadata: JSON.stringify({ type: 'charge.failed' }),
      });

      expect(mockSystemInsert).toHaveBeenCalledWith({
        action: 'stripe.webhook_processed',
        resource_type: 'webhook',
        resource_id: 'evt_1',
        metadata: { type: 'charge.failed' },
      });
      expect(mockAuditInsert).not.toHaveBeenCalled();
    });

    it('wraps non-JSON metadata rather than throwing', async () => {
      await writeSystemAuditLog({
        action: 'a',
        resource_type: 'b',
        resource_id: 'c',
        metadata: 'not-json',
      });

      expect(mockSystemInsert).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { raw: 'not-json' } })
      );
    });
  });
});
