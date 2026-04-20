/**
 * Unit tests for dfTokenCache — shared Datafordeler OAuth token cache.
 *
 * Dækker:
 *  - Returner null ved manglende credentials
 *  - Fetch nyt token ved cache miss
 *  - Return cached token inden udløb (inkl. 60s safety margin)
 *  - Mutex: concurrent kald deler ét token-request
 *  - Graceful null på non-OK response / netværksfejl
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSharedOAuthToken, __resetTokenCacheForTests } from '@/app/lib/dfTokenCache';

const ORIGINAL_FETCH = globalThis.fetch;

function mockTokenResponse(
  opts: {
    ok?: boolean;
    status?: number;
    access_token?: string;
    expires_in?: number;
  } = {}
): Response {
  const ok = opts.ok ?? true;
  if (!ok) {
    return new Response('unauthorized', {
      status: opts.status ?? 401,
      headers: { 'content-type': 'text/plain' },
    });
  }
  return new Response(
    JSON.stringify({
      access_token: opts.access_token ?? 'test-token-123',
      expires_in: opts.expires_in ?? 3600,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

describe('dfTokenCache.getSharedOAuthToken', () => {
  beforeEach(() => {
    process.env.DATAFORDELER_OAUTH_CLIENT_ID = 'client-123';
    process.env.DATAFORDELER_OAUTH_CLIENT_SECRET = 'secret-abc';
    __resetTokenCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.DATAFORDELER_OAUTH_CLIENT_ID;
    delete process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;
    vi.restoreAllMocks();
  });

  it('returns null when CLIENT_ID is missing', async () => {
    delete process.env.DATAFORDELER_OAUTH_CLIENT_ID;
    expect(await getSharedOAuthToken()).toBeNull();
  });

  it('returns null when CLIENT_SECRET is missing', async () => {
    delete process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;
    expect(await getSharedOAuthToken()).toBeNull();
  });

  it('fetches a new token on cache miss', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockTokenResponse({ access_token: 'abc' }));
    globalThis.fetch = fetchMock;
    const token = await getSharedOAuthToken();
    expect(token).toBe('abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns cached token on subsequent call within expiry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockTokenResponse({ access_token: 'cached', expires_in: 3600 }));
    globalThis.fetch = fetchMock;
    const first = await getSharedOAuthToken();
    const second = await getSharedOAuthToken();
    expect(first).toBe('cached');
    expect(second).toBe('cached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when cached token is within 60s safety margin of expiry', async () => {
    // Expires in 30s — safety margin is 60s, so cache should be treated as expired
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'near-expiry', expires_in: 30 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'refreshed', expires_in: 3600 }));
    globalThis.fetch = fetchMock;
    const first = await getSharedOAuthToken();
    const second = await getSharedOAuthToken();
    expect(first).toBe('near-expiry');
    expect(second).toBe('refreshed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when token endpoint returns non-OK', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockTokenResponse({ ok: false, status: 500 }));
    expect(await getSharedOAuthToken()).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));
    expect(await getSharedOAuthToken()).toBeNull();
  });

  it('concurrent calls share a single token-request (mutex)', async () => {
    // Mock fetch to resolve slowly so both calls overlap
    let resolveResponse: (v: Response) => void = () => {};
    const delayedResponse = new Promise<Response>((r) => {
      resolveResponse = r;
    });
    const fetchMock = vi.fn().mockReturnValue(delayedResponse);
    globalThis.fetch = fetchMock;

    const p1 = getSharedOAuthToken();
    const p2 = getSharedOAuthToken();
    const p3 = getSharedOAuthToken();

    // Resolve the underlying fetch — both concurrent awaiters get the same token
    resolveResponse(mockTokenResponse({ access_token: 'mutex-shared' }));
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);

    expect(t1).toBe('mutex-shared');
    expect(t2).toBe('mutex-shared');
    expect(t3).toBe('mutex-shared');
    // Only ONE fetch call — mutex deduplicated the concurrent requests
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends correct POST body (grant_type + client_id + client_secret)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockTokenResponse());
    globalThis.fetch = fetchMock;
    await getSharedOAuthToken();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=client-123');
    expect(body).toContain('client_secret=secret-abc');
  });
});
