/**
 * Unit tests for fetchDawa wrapper (BIZZ-537).
 *
 * Verifies that every DAWA call made through this wrapper is observable:
 *   - Sentry breadcrumb emitted with path-only endpoint (no query string)
 *   - Caller identifier forwarded to the breadcrumb
 *   - Deprecation log line written to the logger
 *   - Underlying fetch called with the exact URL + options provided
 *   - Response passed through unchanged
 *   - No PII (addresses, search terms) leaks into the breadcrumb
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAddBreadcrumb = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: (...args: unknown[]) => mockAddBreadcrumb(...args),
}));

const mockLoggerLog = vi.fn();
vi.mock('@/app/lib/logger', () => ({
  logger: { log: (...args: unknown[]) => mockLoggerLog(...args), error: vi.fn(), warn: vi.fn() },
}));

// Import AFTER mocks are registered so the module picks up our stubs
import { fetchDawa } from '@/app/lib/dawa';

describe('fetchDawa (BIZZ-537)', () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockAddBreadcrumb.mockClear();
    mockLoggerLog.mockClear();
    mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as unknown as Response)
    );
    global.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('forwards URL and options to fetch unchanged', async () => {
    const init: RequestInit = {
      method: 'GET',
      signal: AbortSignal.timeout(1000),
      headers: { Accept: 'application/json' },
    };
    await fetchDawa('https://api.dataforsyningen.dk/bfe/12345', init, { caller: 'test.bfe' });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith('https://api.dataforsyningen.dk/bfe/12345', init);
  });

  it('emits a Sentry breadcrumb with caller + path-only endpoint', async () => {
    await fetchDawa('https://api.dataforsyningen.dk/adresser/abc-uuid?struktur=mini', undefined, {
      caller: 'test.fetch.adresser',
    });

    expect(mockAddBreadcrumb).toHaveBeenCalledOnce();
    const arg = mockAddBreadcrumb.mock.calls[0][0] as {
      category: string;
      message: string;
      level: string;
      data: Record<string, unknown>;
    };
    expect(arg.category).toBe('dawa.call');
    expect(arg.level).toBe('info');
    expect(arg.data.caller).toBe('test.fetch.adresser');
    expect(arg.data.endpoint).toBe('/adresser/abc-uuid');
    expect(arg.data.deadline).toBe('2026-07-01');
  });

  it('strips query strings from the breadcrumb endpoint — no PII leak', async () => {
    // A user-supplied address must NOT end up in Sentry
    await fetchDawa(
      'https://api.dataforsyningen.dk/autocomplete?q=Højbjerg+Strand+23&caretpos=20',
      undefined,
      { caller: 'test.pii' }
    );

    const arg = mockAddBreadcrumb.mock.calls[0][0] as {
      data: { endpoint: string };
      message: string;
    };
    expect(arg.data.endpoint).toBe('/autocomplete');
    expect(arg.data.endpoint).not.toContain('Højbjerg');
    expect(arg.message).not.toContain('Højbjerg');
  });

  it('logs a deprecation line with caller and deadline', async () => {
    await fetchDawa('https://api.dataforsyningen.dk/adgangsadresser/id', undefined, {
      caller: 'test.deprecation',
    });

    expect(mockLoggerLog).toHaveBeenCalledOnce();
    const line = mockLoggerLog.mock.calls[0][0] as string;
    expect(line).toContain('[DAWA deprecated]');
    expect(line).toContain('test.deprecation');
    expect(line).toContain('2026-07-01');
    // No query string leakage in the log either
    expect(line).toContain('/adgangsadresser/id');
  });

  it('returns the native Response untouched (callers can use .ok / .json)', async () => {
    const payload = { bfe: 42 };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    } as unknown as Response);

    const res = await fetchDawa('https://api.dataforsyningen.dk/bfe/42', undefined, {
      caller: 'test.passthrough',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(payload);
  });

  it('tolerates missing caller (defaults to "unknown")', async () => {
    await fetchDawa('https://api.dataforsyningen.dk/autocomplete');

    const arg = mockAddBreadcrumb.mock.calls[0][0] as { data: { caller: string } };
    expect(arg.data.caller).toBe('unknown');
  });
});
