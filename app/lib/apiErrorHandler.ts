/**
 * API Error Handler — Consistent Error Wrapping for Route Handlers
 *
 * Provides a higher-order function that wraps Next.js route handlers in
 * a try/catch boundary. All unhandled exceptions are caught, logged with
 * request context (no PII), and returned as a consistent JSON shape.
 *
 * Usage:
 * ```ts
 * import { withErrorHandler } from '@/app/lib/apiErrorHandler';
 *
 * export const POST = withErrorHandler(async (req) => {
 *   // ... handler logic
 *   return NextResponse.json({ ok: true });
 * });
 * ```
 *
 * @module app/lib/apiErrorHandler
 */

import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '@/app/lib/requestLogger';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Consistent error response shape returned by wrapped handlers. */
export interface ApiErrorResponse {
  /** Human-readable error message */
  error: string;
  /** Machine-readable error code */
  code: string;
}

/** A Next.js route handler function signature. */
type RouteHandler = (
  req: NextRequest,
  ctx?: { params: Promise<Record<string, string>> }
) => Promise<Response | NextResponse>;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Wrap a Next.js route handler in a try/catch boundary. Catches any
 * unhandled exceptions, logs them with safe request context, and returns
 * a standardised error JSON response.
 *
 * Timing is captured and passed to the request logger for both
 * successful and failed requests.
 *
 * @param handler - The async route handler to wrap
 * @returns A new handler with error boundary + request logging
 */
export function withErrorHandler(handler: RouteHandler): RouteHandler {
  return async (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => {
    const start = Date.now();

    try {
      const response = await handler(req, ctx);
      const duration = Date.now() - start;

      // Log successful requests
      logRequest(req, response.status, duration);

      return response;
    } catch (err: unknown) {
      const duration = Date.now() - start;

      // Extract a safe error message (no stack traces in response)
      const message = err instanceof Error ? err.message : 'Internal server error';

      // Log error with context — path + method only, no PII
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          method: req.method,
          path: req.nextUrl.pathname,
          error: message,
          // Stack trace in dev only — production should use Sentry
          ...(process.env.NODE_ENV === 'development' && err instanceof Error
            ? { stack: err.stack }
            : {}),
        })
      );

      logRequest(req, 500, duration);

      const body: ApiErrorResponse = {
        error: process.env.NODE_ENV === 'development' ? message : 'An unexpected error occurred',
        code: 'INTERNAL_ERROR',
      };

      return NextResponse.json(body, { status: 500 });
    }
  };
}
