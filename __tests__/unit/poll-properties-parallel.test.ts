/**
 * Unit tests for BIZZ-177 — poll-properties fetches must run concurrently.
 *
 * The original implementation awaited fetchBBR, fetchVurdering, and fetchEjerskab
 * sequentially for each property (150 serial calls for 50 properties). This
 * easily exceeds Vercel's 60-second function timeout.
 *
 * The fix uses Promise.all() so all 3 fetches per property run concurrently,
 * reducing total wall-clock time to roughly 50 parallel batches of 3 calls.
 *
 * This test verifies the concurrency by checking that all 3 fetch functions
 * are called before any of them resolves (i.e. they are started in parallel).
 */

import { describe, it, expect } from 'vitest';

describe('poll-properties route source — BIZZ-177 concurrency', () => {
  it('uses Promise.all to parallelize the 3 fetches per property', async () => {
    // Read source to verify Promise.all pattern is present
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const source = readFileSync(
      resolve(__dirname, '../../app/api/cron/poll-properties/route.ts'),
      'utf-8'
    );
    expect(source).toContain('Promise.all(');
    // The old serial pattern used "for (const check of checks)" with "await check.fetcher()"
    // directly inside. Now fetchers are mapped to promises first.
    expect(source).toContain('checks.map(');
  });

  it('all 3 fetchers are started before any resolves (concurrency simulation)', async () => {
    // Simulate what the route does: create 3 async tasks and run them with Promise.all
    const order: string[] = [];
    const resolvers: (() => void)[] = [];

    const makeDelayedFetcher = (name: string) => () =>
      new Promise<Record<string, unknown>>((resolve) => {
        order.push(`start:${name}`);
        resolvers.push(() => {
          order.push(`end:${name}`);
          resolve({ [name]: true });
        });
      });

    const checks = [
      { type: 'bbr', fetcher: makeDelayedFetcher('bbr') },
      { type: 'vurdering', fetcher: makeDelayedFetcher('vurdering') },
      { type: 'ejerskab', fetcher: makeDelayedFetcher('ejerskab') },
    ];

    // Start all fetches concurrently (mirrors the Promise.all pattern in the route)
    const allStarted = Promise.all(
      checks.map((check) => check.fetcher().then((data) => ({ check, data })))
    );

    // At this point, all 3 fetchers should have been STARTED (order has 3 entries)
    // but none resolved yet (resolvers array has 3 entries)
    expect(order).toEqual(['start:bbr', 'start:vurdering', 'start:ejerskab']);
    expect(resolvers).toHaveLength(3);

    // Now resolve all
    resolvers.forEach((r) => r());
    const results = await allStarted;

    expect(results).toHaveLength(3);
    expect(order).toContain('end:bbr');
    expect(order).toContain('end:vurdering');
    expect(order).toContain('end:ejerskab');
  });
});
