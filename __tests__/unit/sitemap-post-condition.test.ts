/**
 * BIZZ-2239: Unit-tests for sitemap-kontinuitet post-condition.
 *
 * Verificerer at checkSitemapContinuity fanger huller + sidetals-mismatch i
 * sitemap_xml_cache (brudt output selv naar generate-sitemap rapporterede success).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
import { createAdminClient } from '@/lib/supabase/admin';
import { checkSitemapContinuity } from '@/app/lib/cron/postConditions';

/** Byg en fake admin-client med kontrollerede page_ids + entry-count. */
function fakeAdmin(
  pageIds: number[] | null,
  entryCount: number,
  opts: { pErr?: string; eErr?: string } = {}
) {
  return {
    from(table: string) {
      if (table === 'sitemap_xml_cache') {
        return {
          select: () => ({
            order: () =>
              Promise.resolve({
                data: pageIds?.map((page_id) => ({ page_id })) ?? null,
                error: opts.pErr ? { message: opts.pErr } : null,
              }),
          }),
        };
      }
      // sitemap_entries — count/head
      return {
        select: () =>
          Promise.resolve({ count: entryCount, error: opts.eErr ? { message: opts.eErr } : null }),
      };
    },
  };
}

const mockAdmin = vi.mocked(createAdminClient);
beforeEach(() => vi.clearAllMocks());

describe('BIZZ-2239 checkSitemapContinuity', () => {
  it('ok naar sider er kontinuerte 0..N-1 og N matcher entry-count', async () => {
    // 60000 entries + 4 static → ceil(60004/50000) = 2 sider (0,1)
    mockAdmin.mockReturnValue(fakeAdmin([0, 1], 60000) as never);
    const r = await checkSitemapContinuity();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('2 sider');
  });

  it('fanger huller i page_ids', async () => {
    // forventer 3 sider (0,1,2) for 120000 entries, men side 1 mangler
    mockAdmin.mockReturnValue(fakeAdmin([0, 2], 120000) as never);
    const r = await checkSitemapContinuity();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('manglende page_ids: 1');
  });

  it('fanger for faa sider (max page_id < forventet)', async () => {
    // 4.8M entries → ceil(4800004/50000) = 97 sider, men kun 66 findes
    const present = Array.from({ length: 66 }, (_, i) => i);
    mockAdmin.mockReturnValue(fakeAdmin(present, 4_800_000) as never);
    const r = await checkSitemapContinuity();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('forventet 97 sider');
  });

  it('tom cache er ok (fallback-estimering)', async () => {
    mockAdmin.mockReturnValue(fakeAdmin([], 0) as never);
    const r = await checkSitemapContinuity();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('tom');
  });

  it('DB-fejl på cache-laesning giver ok=false', async () => {
    mockAdmin.mockReturnValue(fakeAdmin(null, 0, { pErr: 'boom' }) as never);
    const r = await checkSitemapContinuity();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('boom');
  });
});
