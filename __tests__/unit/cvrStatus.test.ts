/**
 * Unit tests for cvrStatus.ts — CVR ES livsforloeb + sammensatStatus lookup.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { hentCvrStatus, hentCvrStatusBatch } from '@/app/lib/cvrStatus';

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Build a minimal CVR ES response for the virksomhed endpoint.
 */
function makeEsResponse(opts: {
  navn?: string | null;
  harSlutdato?: boolean;
  sammensatStatus?: string | null;
  empty?: boolean;
}): Response {
  if (opts.empty) {
    return new Response(JSON.stringify({ hits: { hits: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const livsforloeb = opts.harSlutdato
    ? [{ periode: { gyldigFra: '2020-01-01', gyldigTil: '2024-06-30' } }]
    : [{ periode: { gyldigFra: '2020-01-01', gyldigTil: null } }];
  const navne =
    opts.navn !== undefined
      ? opts.navn == null
        ? []
        : [{ navn: opts.navn, periode: { gyldigFra: '2020-01-01', gyldigTil: null } }]
      : [];
  const virksomhedMetadata =
    opts.sammensatStatus !== undefined ? { sammensatStatus: opts.sammensatStatus } : {};
  return new Response(
    JSON.stringify({
      hits: {
        hits: [
          {
            _source: {
              Vrvirksomhed: { navne, livsforloeb, virksomhedMetadata },
            },
          },
        ],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

describe('cvrStatus.hentCvrStatus', () => {
  beforeEach(() => {
    process.env.CVR_ES_USER = 'u';
    process.env.CVR_ES_PASS = 'p';
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.CVR_ES_USER;
    delete process.env.CVR_ES_PASS;
  });

  it('returns null when credentials are missing', async () => {
    delete process.env.CVR_ES_USER;
    expect(await hentCvrStatus(12345678)).toBeNull();
  });

  it('returns null when CVR ES responds non-OK', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('oops', { status: 500 }));
    expect(await hentCvrStatus(12345678)).toBeNull();
  });

  it('returns cvr/null/false when no hits found', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeEsResponse({ empty: true }));
    const r = await hentCvrStatus(12345678);
    expect(r).toEqual({ cvr: 12345678, navn: null, isCeased: false });
  });

  it('returns active virksomhedsnavn when livsforloeb is open-ended', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeEsResponse({ navn: 'Test ApS', harSlutdato: false }));
    const r = await hentCvrStatus(12345678);
    expect(r).toEqual({ cvr: 12345678, navn: 'Test ApS', isCeased: false });
  });

  it('marks as ceased when livsforloeb has a gyldigTil set', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeEsResponse({ navn: 'Gone ApS', harSlutdato: true }));
    const r = await hentCvrStatus(12345678);
    expect(r?.isCeased).toBe(true);
  });

  it('marks as ceased when sammensatStatus is Ophørt (even without slutdato)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        makeEsResponse({ navn: 'X', harSlutdato: false, sammensatStatus: 'Ophørt' })
      );
    const r = await hentCvrStatus(12345678);
    expect(r?.isCeased).toBe(true);
  });

  it('does NOT mark as ceased when sammensatStatus is Aktiv', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        makeEsResponse({ navn: 'Y', harSlutdato: false, sammensatStatus: 'Aktiv' })
      );
    const r = await hentCvrStatus(12345678);
    expect(r?.isCeased).toBe(false);
  });

  it('returns null when fetch throws (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    expect(await hentCvrStatus(12345678)).toBeNull();
  });

  it('handles missing navne array gracefully (returns navn=null)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeEsResponse({ navn: null }));
    const r = await hentCvrStatus(12345678);
    expect(r?.navn).toBeNull();
  });
});

describe('cvrStatus.hentCvrStatusBatch', () => {
  beforeEach(() => {
    process.env.CVR_ES_USER = 'u';
    process.env.CVR_ES_PASS = 'p';
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('deduplicates input CVRs', async () => {
    const calls: number[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      calls.push(body.query.term['Vrvirksomhed.cvrNummer']);
      return makeEsResponse({ navn: 'A', harSlutdato: false });
    });
    const out = await hentCvrStatusBatch([1, 2, 2, 1, 3]);
    expect(out.size).toBe(3);
    // Each unique CVR fetched at most once
    expect(new Set(calls).size).toBe(3);
  });

  it('skips CVRs whose lookup returned null (missing creds / network error)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('fail', { status: 503 }));
    const out = await hentCvrStatusBatch([1, 2, 3]);
    expect(out.size).toBe(0);
  });

  it('honours concurrency chunks (processes in batches)', async () => {
    let inFlight = 0;
    let maxSeen = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxSeen = Math.max(maxSeen, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return makeEsResponse({ navn: 'x', harSlutdato: false });
    });
    await hentCvrStatusBatch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
    expect(maxSeen).toBeLessThanOrEqual(3);
  });
});
