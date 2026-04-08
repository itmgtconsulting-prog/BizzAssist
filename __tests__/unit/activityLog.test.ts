/**
 * Unit tests for app/lib/activityLog.
 *
 * logActivity is a fire-and-forget function — it calls supabase.schema('tenant')
 * .from('activity_log').insert(...) without blocking the caller.
 * All errors are silently swallowed so logging never surfaces to the user.
 *
 * Covers:
 * - Insert is called with the correct parameters
 * - Supabase insert failure does not throw
 * - Default empty payload is used when no payload is provided
 * - All ActivityEventType values are accepted
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logActivity, type ActivityEventType } from '@/app/lib/activityLog';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Factory helpers ─────────────────────────────────────────────────────────

/**
 * Builds a minimal Supabase mock whose .schema().from().insert() call resolves
 * to the given value.
 */
function makeSupabase(insertResult: Promise<{ error: null | Error }>): {
  client: SupabaseClient;
  mockInsert: ReturnType<typeof vi.fn>;
} {
  const mockInsert = vi.fn().mockReturnValue(insertResult);
  const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
  const mockSchema = vi.fn().mockReturnValue({ from: mockFrom });
  const client = { schema: mockSchema } as unknown as SupabaseClient;
  return { client, mockInsert };
}

describe('logActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls supabase.schema with "tenant"', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ error: null });
    const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
    const mockSchema = vi.fn().mockReturnValue({ from: mockFrom });
    const client = { schema: mockSchema } as unknown as SupabaseClient;

    logActivity(client, 'tenant-1', 'user-1', 'address_search', { queryLength: 5 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSchema).toHaveBeenCalledWith('tenant');
  });

  it('calls .from("activity_log")', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ error: null });
    const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
    const mockSchema = vi.fn().mockReturnValue({ from: mockFrom });
    const client = { schema: mockSchema } as unknown as SupabaseClient;

    logActivity(client, 'tenant-1', 'user-1', 'ai_chat', {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockFrom).toHaveBeenCalledWith('activity_log');
  });

  it('calls insert with correct tenant_id, user_id, event_type and payload', async () => {
    const { client, mockInsert } = makeSupabase(Promise.resolve({ error: null }));

    logActivity(client, 'tenant-abc', 'user-xyz', 'property_open', { bfe: 12345 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockInsert).toHaveBeenCalledWith({
      tenant_id: 'tenant-abc',
      user_id: 'user-xyz',
      event_type: 'property_open',
      payload: { bfe: 12345 },
    });
  });

  it('uses empty object as default payload when none provided', async () => {
    const { client, mockInsert } = makeSupabase(Promise.resolve({ error: null }));

    logActivity(client, 't', 'u', 'page_view');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ payload: {} }));
  });

  it('does not throw synchronously when insert rejects', () => {
    const mockInsert = vi.fn().mockRejectedValue(new Error('DB error'));
    const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
    const mockSchema = vi.fn().mockReturnValue({ from: mockFrom });
    const client = { schema: mockSchema } as unknown as SupabaseClient;

    expect(() => logActivity(client, 't', 'u', 'ai_chat', {})).not.toThrow();
  });

  it('swallows rejected promise without unhandled rejection', async () => {
    const mockInsert = vi.fn().mockRejectedValue(new Error('Network timeout'));
    const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
    const mockSchema = vi.fn().mockReturnValue({ from: mockFrom });
    const client = { schema: mockSchema } as unknown as SupabaseClient;

    logActivity(client, 't', 'u', 'company_open', {});
    // Wait long enough for the rejected promise to settle
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No assertion needed — the test passes if no unhandled rejection was thrown
  });

  it('does not throw synchronously when insert resolves with an error object', async () => {
    const { client } = makeSupabase(Promise.resolve({ error: new Error('Constraint violation') }));

    expect(() => logActivity(client, 't', 'u', 'owner_open', {})).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
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
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ event_type: eventType }));
    }
  });

  it('is fire-and-forget — returns void immediately', () => {
    const { client } = makeSupabase(new Promise(() => {})); // never resolves
    const result = logActivity(client, 't', 'u', 'page_view', {});
    expect(result).toBeUndefined();
  });
});
