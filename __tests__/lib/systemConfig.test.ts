/**
 * Unit tests for app/lib/systemConfig.ts (BIZZ-419).
 *
 * Tester layered fallback: cache → DB → env → default. DB-laget mockes
 * via createAdminClient så vi ikke rammer Supabase under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock admin client før systemConfig importeres
const mockMaybeSingle = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockMaybeSingle,
        }),
      }),
    }),
  }),
}));

import { getConfig, invalidateConfig, clearConfigCache } from '@/app/lib/systemConfig';

describe('systemConfig.getConfig', () => {
  beforeEach(() => {
    clearConfigCache();
    mockMaybeSingle.mockReset();
  });

  afterEach(() => {
    // Sikre at env-vars sat af tests ikke lækker
    delete process.env.SUPPORT_EMAIL;
    delete process.env.AI_TOOLS_ENABLED;
  });

  it('returnerer DB-værdi når den findes', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { value: 'admin@example.com' } });
    const v = await getConfig('support_email', 'fallback@example.com');
    expect(v).toBe('admin@example.com');
  });

  it('returnerer env-variabel når DB er tom', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null });
    process.env.SUPPORT_EMAIL = 'env@example.com';
    const v = await getConfig('support_email', 'fallback@example.com');
    expect(v).toBe('env@example.com');
  });

  it('parser JSON-env-variabel', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null });
    process.env.AI_TOOLS_ENABLED = 'true';
    const v = await getConfig<boolean>('ai_tools_enabled', false);
    expect(v).toBe(true);
  });

  it('returnerer defaultValue når hverken DB eller env har værdi', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null });
    const v = await getConfig('totally_missing_key', 42);
    expect(v).toBe(42);
  });

  it('cacher DB-værdi så næste kald ikke rammer DB', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { value: 'cached-value' } });
    const first = await getConfig('cache_test', 'default');
    expect(first).toBe('cached-value');
    // Anden opslag — DB må ikke kaldes
    const second = await getConfig('cache_test', 'default');
    expect(second).toBe('cached-value');
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('invalidateConfig tvinger fresh DB-lookup', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { value: 'old' } });
    await getConfig('reload_test', 'default');
    invalidateConfig('reload_test');
    mockMaybeSingle.mockResolvedValueOnce({ data: { value: 'new' } });
    const v = await getConfig('reload_test', 'default');
    expect(v).toBe('new');
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it('understøtter object-værdier (JSONB)', async () => {
    const obj = { host: 'api.example.com', port: 443 };
    mockMaybeSingle.mockResolvedValueOnce({ data: { value: obj } });
    const v = await getConfig<{ host: string; port: number }>('endpoint_config', {
      host: '',
      port: 0,
    });
    expect(v).toEqual(obj);
  });

  it('fanger DB-exceptions og falder tilbage til default', async () => {
    mockMaybeSingle.mockRejectedValueOnce(new Error('DB down'));
    const v = await getConfig('broken_key', 'safe-default');
    expect(v).toBe('safe-default');
  });
});
