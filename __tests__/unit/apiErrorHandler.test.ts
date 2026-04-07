/**
 * Unit tests for app/lib/apiErrorHandler.
 *
 * withErrorHandler wraps a Next.js route handler in a try/catch boundary.
 * Successful handlers have their response returned unchanged.
 * Throwing handlers produce a 500 JSON response with code INTERNAL_ERROR.
 *
 * requestLogger is mocked so no real console.log output happens in tests,
 * and to verify it's called for both success and error paths.
 *
 * Covers:
 * - Passes through the response from a successful handler
 * - Returns 500 JSON with code INTERNAL_ERROR on throw
 * - Error message is included in development mode
 * - Generic message is returned in production mode
 * - logRequest is called for successful requests
 * - logRequest is called with status 500 for failed requests
 * - Non-Error throws are handled gracefully
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ─── Mock requestLogger ───────────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file by Vitest, so we cannot reference
// variables declared in the module scope inside the factory. Instead we use
// vi.hoisted() to create the spy BEFORE the hoist boundary.
const { mockLogRequest } = vi.hoisted(() => ({
  mockLogRequest: vi.fn(),
}));

vi.mock('@/app/lib/requestLogger', () => ({
  logRequest: mockLogRequest,
}));

import { withErrorHandler, type ApiErrorResponse } from '@/app/lib/apiErrorHandler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal NextRequest for a given path.
 */
function makeRequest(path = '/api/test'): NextRequest {
  return new NextRequest(`https://bizzassist.dk${path}`);
}

describe('withErrorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the handler response unchanged on success', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }, { status: 200 }));
    const wrapped = withErrorHandler(handler);
    const res = await wrapped(makeRequest());
    expect(res.status).toBe(200);
  });

  it('passes the request through to the handler', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withErrorHandler(handler);
    const req = makeRequest('/api/specific');
    await wrapped(req);
    expect(handler).toHaveBeenCalledWith(req, undefined);
  });

  it('passes ctx through to the handler', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withErrorHandler(handler);
    const req = makeRequest();
    const ctx = { params: Promise.resolve({ id: '123' }) };
    await wrapped(req, ctx);
    expect(handler).toHaveBeenCalledWith(req, ctx);
  });

  it('returns 500 JSON when handler throws an Error', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('Something broke'));
    const wrapped = withErrorHandler(handler);
    const res = await wrapped(makeRequest());
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiErrorResponse;
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('includes error message in development mode', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const handler = vi.fn().mockRejectedValue(new Error('Dev error message'));
    const wrapped = withErrorHandler(handler);
    const res = await wrapped(makeRequest());
    const body = (await res.json()) as ApiErrorResponse;
    expect(body.error).toBe('Dev error message');
  });

  it('returns generic message in production mode', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const handler = vi.fn().mockRejectedValue(new Error('Internal details'));
    const wrapped = withErrorHandler(handler);
    const res = await wrapped(makeRequest());
    const body = (await res.json()) as ApiErrorResponse;
    expect(body.error).toBe('An unexpected error occurred');
  });

  it('handles non-Error throws gracefully', async () => {
    const handler = vi.fn().mockImplementation(() => {
      throw 'string error';
    });
    vi.stubEnv('NODE_ENV', 'production');
    const wrapped = withErrorHandler(handler);
    const res = await wrapped(makeRequest());
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiErrorResponse;
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('calls logRequest with the correct status on success', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }, { status: 201 }));
    const wrapped = withErrorHandler(handler);
    await wrapped(makeRequest());
    expect(mockLogRequest).toHaveBeenCalledWith(expect.anything(), 201, expect.any(Number));
  });

  it('calls logRequest with status 500 on error', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('oops'));
    const wrapped = withErrorHandler(handler);
    await wrapped(makeRequest());
    expect(mockLogRequest).toHaveBeenCalledWith(expect.anything(), 500, expect.any(Number));
  });

  it('passes a non-negative duration to logRequest', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withErrorHandler(handler);
    await wrapped(makeRequest());
    const duration = mockLogRequest.mock.calls[0][2] as number;
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it('wraps async handlers that return non-JSON responses', async () => {
    const handler = vi.fn().mockResolvedValue(new Response('plain text', { status: 200 }));
    const wrapped = withErrorHandler(handler);
    const res = await wrapped(makeRequest());
    expect(res.status).toBe(200);
  });
});
