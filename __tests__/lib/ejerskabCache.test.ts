/**
 * Unit tests for ejerskab cache (BIZZ-1582).
 *
 * buildChainCacheKey: deterministisk key-format.
 * getCached/setCached/withCache/invalidateByBfe: integration via mocked
 *   Supabase-klient (kan ikke teste mod live DB i unit-suite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @supabase/supabase-js før import
vi.mock('@supabase/supabase-js', () => {
  return {
    createClient: vi.fn(),
  };
});

import { createClient } from '@supabase/supabase-js';
import {
  buildChainCacheKey,
  getCached,
  setCached,
  withCache,
  invalidateByBfe,
  _resetClientForTests,
} from '@/app/lib/ejerskab/cache';

const mockCreate = vi.mocked(createClient);

interface MockTable {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function makeMockClient(table: Partial<MockTable> = {}): {
  from: ReturnType<typeof vi.fn>;
} {
  const defaultTable: MockTable = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
    delete: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    ...table,
  };
  return {
    from: vi.fn(() => defaultTable),
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  _resetClientForTests();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
});

describe('buildChainCacheKey', () => {
  it('returnerer fuld-variant for almindelige ejendomme', () => {
    expect(buildChainCacheKey(12345, '')).toBe('ejerskab-chain:bfe:12345:type:fuld');
    expect(buildChainCacheKey(12345, 'hus')).toBe('ejerskab-chain:bfe:12345:type:fuld');
  });

  it('returnerer lejlighed-variant for ejerlejligheder', () => {
    expect(buildChainCacheKey(12345, 'ejerlejlighed')).toBe(
      'ejerskab-chain:bfe:12345:type:lejlighed'
    );
    expect(buildChainCacheKey(12345, 'EJERLEJLIGHED')).toBe(
      'ejerskab-chain:bfe:12345:type:lejlighed'
    );
  });

  it('accepterer både string og number bfe', () => {
    expect(buildChainCacheKey('999', '')).toBe('ejerskab-chain:bfe:999:type:fuld');
    expect(buildChainCacheKey(999, '')).toBe('ejerskab-chain:bfe:999:type:fuld');
  });
});

describe('getCached', () => {
  it('returnerer null hvis env mangler', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mockCreate.mockReturnValue(makeMockClient() as never);
    const r = await getCached<{ x: number }>('key:1');
    expect(r).toBeNull();
  });

  it('returnerer payload ved frisk cache-hit', async () => {
    const fresh = new Date().toISOString();
    const table: Partial<MockTable> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { payload: { foo: 'bar' }, fetched_at: fresh, ttl_minutes: 60 },
        error: null,
      }),
    };
    mockCreate.mockReturnValue(makeMockClient(table) as never);
    const r = await getCached<{ foo: string }>('key:1');
    expect(r).toEqual({ foo: 'bar' });
  });

  it('returnerer null hvis cache-entry er udløbet', async () => {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2t gammel
    const table: Partial<MockTable> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { payload: { foo: 'bar' }, fetched_at: stale, ttl_minutes: 60 }, // ttl 1t
        error: null,
      }),
    };
    mockCreate.mockReturnValue(makeMockClient(table) as never);
    const r = await getCached('key:1');
    expect(r).toBeNull();
  });

  it('returnerer null ved DB-fejl', async () => {
    const table: Partial<MockTable> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: new Error('db down') }),
    };
    mockCreate.mockReturnValue(makeMockClient(table) as never);
    const r = await getCached('key:1');
    expect(r).toBeNull();
  });
});

describe('setCached', () => {
  it('upserter med default TTL', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mockCreate.mockReturnValue(makeMockClient({ upsert: upsert.mockReturnThis() }) as never);
    await setCached('key:1', { x: 1 });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        cache_key: 'key:1',
        payload: { x: 1 },
        ttl_minutes: 360,
      }),
      { onConflict: 'cache_key' }
    );
  });

  it('upserter med custom TTL og BFE', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mockCreate.mockReturnValue(makeMockClient({ upsert: upsert.mockReturnThis() }) as never);
    await setCached('key:1', { x: 1 }, { bfeNummer: 999, ttlMinutes: 30 });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        cache_key: 'key:1',
        bfe_nummer: 999,
        ttl_minutes: 30,
      }),
      { onConflict: 'cache_key' }
    );
  });
});

describe('withCache', () => {
  it('returnerer cached payload uden at kalde compute', async () => {
    const fresh = new Date().toISOString();
    const table: Partial<MockTable> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { payload: { cached: true }, fetched_at: fresh, ttl_minutes: 60 },
        error: null,
      }),
    };
    mockCreate.mockReturnValue(makeMockClient(table) as never);
    const compute = vi.fn();
    const r = await withCache('key:1', compute);
    expect(r.cached).toBe(true);
    expect(r.payload).toEqual({ cached: true });
    expect(compute).not.toHaveBeenCalled();
  });

  it('kalder compute ved miss og skriver til cache', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mockCreate.mockReturnValue(makeMockClient({ upsert: upsert.mockReturnThis() }) as never);
    const compute = vi.fn().mockResolvedValue({ fresh: true });
    const r = await withCache('key:1', compute);
    expect(r.cached).toBe(false);
    expect(r.payload).toEqual({ fresh: true });
    expect(compute).toHaveBeenCalledOnce();
  });
});

describe('invalidateByBfe', () => {
  it('sletter alle entries for én BFE', async () => {
    const eq = vi.fn().mockResolvedValue({ count: 3, error: null });
    const del = vi.fn().mockReturnValue({ eq });
    mockCreate.mockReturnValue(makeMockClient({ delete: del as never }) as never);
    const n = await invalidateByBfe(12345);
    expect(n).toBe(3);
    expect(del).toHaveBeenCalledWith({ count: 'exact' });
    expect(eq).toHaveBeenCalledWith('bfe_nummer', 12345);
  });
});
