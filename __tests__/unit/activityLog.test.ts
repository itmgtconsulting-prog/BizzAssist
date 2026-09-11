/**
 * Unit tests for app/lib/activityLog.
 *
 * logActivity is a fire-and-forget function. It first resolves the tenant's
 * per-tenant schema name from public.tenants, then calls
 * supabase.schema(schemaName).from('activity_log').insert(...) without blocking
 * the caller (BIZZ-2288 — the shared 'tenant' schema is not PostgREST-exposed).
 * All errors are silently swallowed so logging never surfaces to the user.
 *
 * Covers:
 * - Resolves + writes to the per-tenant schema (not the literal 'tenant')
 * - Insert is called with the correct parameters
 * - Skips the insert when the tenant has no schema_name
 * - Supabase failure does not throw / no unhandled rejection
 * - Default empty payload; all ActivityEventType values accepted
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logActivity, type ActivityEventType } from '@/app/lib/activityLog';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Factory helpers ─────────────────────────────────────────────────────────

/**
 * Builds a Supabase mock for the two-step logActivity flow:
 *   1. .from('tenants').select('schema_name').eq('id', …).single() → { schema_name }
 *   2. .schema(schemaName).from('activity_log').insert(...) → insertResult
 *
 * @param insertResult - Promise the insert resolves/rejects with
 * @param schemaName   - schema_name returned by the tenants lookup (null to simulate missing)
 */
function makeSupabase(
  insertResult: Promise<{ error: null | Error }>,
  schemaName: string | null = 'tenant_acme'
): {
  client: SupabaseClient;
  mockInsert: ReturnType<typeof vi.fn>;
  mockSchema: ReturnType<typeof vi.fn>;
  mockActivityFrom: ReturnType<typeof vi.fn>;
} {
  const mockInsert = vi.fn().mockReturnValue(insertResult);
  const mockActivityFrom = vi.fn().mockReturnValue({ insert: mockInsert });
  const mockSchema = vi.fn().mockReturnValue({ from: mockActivityFrom });

  // public.tenants lookup chain
  const mockSingle = vi
    .fn()
    .mockResolvedValue({ data: schemaName ? { schema_name: schemaName } : null });
  const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
  const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
  const mockPublicFrom = vi.fn().mockReturnValue({ select: mockSelect });

  const client = { from: mockPublicFrom, schema: mockSchema } as unknown as SupabaseClient;
  return { client, mockInsert, mockSchema, mockActivityFrom };
}

/** Waits for the fire-and-forget async IIFE (2 awaited steps) to settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('logActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves and writes to the per-tenant schema (not the literal "tenant")', async () => {
    const { client, mockSchema } = makeSupabase(Promise.resolve({ error: null }), 'tenant_acme');

    logActivity(client, 'tenant-1', 'user-1', 'address_search', { queryLength: 5 });
    await flush();

    expect(mockSchema).toHaveBeenCalledWith('tenant_acme');
    expect(mockSchema).not.toHaveBeenCalledWith('tenant');
  });

  it('calls .from("activity_log") on the resolved schema', async () => {
    const { client, mockActivityFrom } = makeSupabase(Promise.resolve({ error: null }));

    logActivity(client, 'tenant-1', 'user-1', 'ai_chat', {});
    await flush();

    expect(mockActivityFrom).toHaveBeenCalledWith('activity_log');
  });

  it('calls insert with correct tenant_id, user_id, event_type and payload', async () => {
    const { client, mockInsert } = makeSupabase(Promise.resolve({ error: null }));

    logActivity(client, 'tenant-abc', 'user-xyz', 'property_open', { bfe: 12345 });
    await flush();

    expect(mockInsert).toHaveBeenCalledWith({
      tenant_id: 'tenant-abc',
      user_id: 'user-xyz',
      event_type: 'property_open',
      payload: { bfe: 12345 },
    });
  });

  it('skips the insert when the tenant has no schema_name', async () => {
    const { client, mockInsert, mockSchema } = makeSupabase(Promise.resolve({ error: null }), null);

    logActivity(client, 'ghost-tenant', 'user-1', 'page_view', {});
    await flush();

    expect(mockSchema).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('uses empty object as default payload when none provided', async () => {
    const { client, mockInsert } = makeSupabase(Promise.resolve({ error: null }));

    logActivity(client, 't', 'u', 'page_view');
    await flush();

    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ payload: {} }));
  });

  it('does not throw synchronously when insert rejects', () => {
    const { client } = makeSupabase(Promise.reject(new Error('DB error')));
    expect(() => logActivity(client, 't', 'u', 'ai_chat', {})).not.toThrow();
  });

  it('swallows rejected promise without unhandled rejection', async () => {
    const { client } = makeSupabase(Promise.reject(new Error('Network timeout')));
    logActivity(client, 't', 'u', 'company_open', {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No assertion needed — the test passes if no unhandled rejection was thrown
  });

  it('does not throw synchronously when insert resolves with an error object', async () => {
    const { client } = makeSupabase(Promise.resolve({ error: new Error('Constraint violation') }));
    expect(() => logActivity(client, 't', 'u', 'owner_open', {})).not.toThrow();
    await flush();
  });

  it('accepts all valid ActivityEventType values', async () => {
    const eventTypes: ActivityEventType[] = [
      'address_search',
      'ai_chat',
      'page_view',
      'property_open',
      'company_open',
      'owner_open',
    ];

    for (const eventType of eventTypes) {
      const { client, mockInsert } = makeSupabase(Promise.resolve({ error: null }));
      logActivity(client, 't', 'u', eventType, {});
      await flush();
      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ event_type: eventType }));
    }
  });

  it('is fire-and-forget — returns void immediately', () => {
    const { client } = makeSupabase(new Promise(() => {})); // never resolves
    const result = logActivity(client, 't', 'u', 'page_view', {});
    expect(result).toBeUndefined();
  });
});
