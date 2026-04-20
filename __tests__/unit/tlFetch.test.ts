/**
 * Unit tests for app/lib/tlFetch — BIZZ-599.
 *
 * Covers the proxy-first, direct-mTLS-fallback behaviour of tlFetch + tlPost
 * without requiring real Tinglysning credentials. Uses vi.fn mock on
 * globalThis.fetch + setting DF_PROXY_URL so only the proxy branch is hit.
 *
 * The direct-mTLS path is not exercised here — it requires a valid
 * client-certificate and can only be covered in an integration test against
 * Tinglysning's test environment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('tlFetch + tlPost — proxy path', () => {
  const originalFetch = globalThis.fetch;
  const originalProxy = process.env.DF_PROXY_URL;
  const originalSecret = process.env.DF_PROXY_SECRET;
  const originalBase = process.env.TINGLYSNING_BASE_URL;

  beforeEach(() => {
    process.env.DF_PROXY_URL = 'https://proxy.example.com';
    process.env.DF_PROXY_SECRET = 'super-secret';
    process.env.TINGLYSNING_BASE_URL = 'https://test.tinglysning.dk';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalProxy === undefined) delete process.env.DF_PROXY_URL;
    else process.env.DF_PROXY_URL = originalProxy;
    if (originalSecret === undefined) delete process.env.DF_PROXY_SECRET;
    else process.env.DF_PROXY_SECRET = originalSecret;
    if (originalBase === undefined) delete process.env.TINGLYSNING_BASE_URL;
    else process.env.TINGLYSNING_BASE_URL = originalBase;
    vi.resetModules();
  });

  it('rewrites target URL through proxy and forwards X-Proxy-Secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '<ejendom/>',
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { tlFetch } = await import('@/app/lib/tlFetch');
    const res = await tlFetch('/ejendom/100165718');

    expect(res.status).toBe(200);
    expect(res.body).toBe('<ejendom/>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://proxy.example.com/proxy/test.tinglysning.dk/tinglysning/ssl/ejendom/100165718'
    );
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Proxy-Secret']).toBe('super-secret');
    expect(headers.Accept).toContain('application/json');
  });

  it('honours custom apiPath option (unsecuressl)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => '{}' });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { tlFetch } = await import('@/app/lib/tlFetch');
    await tlFetch('/foo', { apiPath: '/tinglysning/unsecuressl' });

    const [url] = fetchMock.mock.calls[0] as [string, unknown];
    expect(url).toContain('/tinglysning/unsecuressl/foo');
  });

  it('tlPost sends JSON body and Content-Type header through proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 201, text: async () => '{"ok":true}' });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { tlPost } = await import('@/app/lib/tlFetch');
    const res = await tlPost('/tinglysningsobjekter/aendringer', { fromDate: '2026-01-01' });

    expect(res.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ fromDate: '2026-01-01' }));
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toContain('application/json');
  });

  it('tlPost accepts raw string body without re-stringifying', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => '' });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { tlPost } = await import('@/app/lib/tlFetch');
    await tlPost('/echo', '<xml/>');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('<xml/>');
  });

  it('getTlBase returns env override when set', async () => {
    process.env.TINGLYSNING_BASE_URL = 'https://staging.tinglysning.dk';
    const { getTlBase } = await import('@/app/lib/tlFetch');
    expect(getTlBase()).toBe('https://staging.tinglysning.dk');
  });

  it('getTlBase falls back to test.tinglysning.dk when env is missing', async () => {
    delete process.env.TINGLYSNING_BASE_URL;
    const { getTlBase } = await import('@/app/lib/tlFetch');
    expect(getTlBase()).toBe('https://test.tinglysning.dk');
  });

  it('does not set X-Proxy-Secret header when DF_PROXY_SECRET is not configured', async () => {
    delete process.env.DF_PROXY_SECRET;
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => '' });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { tlFetch } = await import('@/app/lib/tlFetch');
    await tlFetch('/noauth');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Proxy-Secret']).toBeUndefined();
  });
});
