/**
 * Request Logger — Structured JSON Logging
 *
 * Logs API request metadata (method, path, status, duration) in a
 * structured JSON format. No PII is ever logged (ISO 27001 compliance).
 *
 * In development, logs are written to stdout with colour formatting.
 * In production, logs are plain JSON for log aggregation pipelines.
 *
 * Usage:
 * ```ts
 * import { logRequest } from '@/app/lib/requestLogger';
 *
 * const start = Date.now();
 * // ... handle request ...
 * logRequest(req, 200, Date.now() - start);
 * ```
 *
 * @module app/lib/requestLogger
 */

import { NextRequest } from 'next/server';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Shape of a structured log entry. */
interface RequestLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log level */
  level: 'info' | 'warn' | 'error';
  /** HTTP method */
  method: string;
  /** URL path (no query string — may contain PII in search params) */
  path: string;
  /** HTTP status code */
  status: number;
  /** Request duration in milliseconds */
  durationMs: number;
  /** User agent category (browser family, not full UA string) */
  userAgentCategory?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV === 'development';

/**
 * Categorise a User-Agent string into a broad family.
 * We never log the full UA string (may contain device identifiers).
 *
 * @param ua - Raw User-Agent header value
 * @returns Broad category string
 */
function categoriseUserAgent(ua: string | null): string | undefined {
  if (!ua) return undefined;
  if (ua.includes('curl') || ua.includes('httpie')) return 'cli';
  if (ua.includes('Postman')) return 'postman';
  if (ua.includes('Chrome')) return 'chrome';
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Safari')) return 'safari';
  if (ua.includes('Edge')) return 'edge';
  return 'other';
}

/**
 * Derive log level from HTTP status code.
 *
 * @param status - HTTP status code
 * @returns Appropriate log level
 */
function levelFromStatus(status: number): 'info' | 'warn' | 'error' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

// ─── Colours for dev output ─────────────────────────────────────────────────

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

/**
 * Pick colour escape code based on status code.
 *
 * @param status - HTTP status code
 * @returns ANSI colour escape
 */
function statusColour(status: number): string {
  if (status >= 500) return RED;
  if (status >= 400) return YELLOW;
  if (status >= 300) return CYAN;
  return GREEN;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Log a completed API request. Writes structured JSON to stdout.
 * Sensitive data (IP, full URL with query params, auth headers) is
 * intentionally excluded to comply with ISO 27001 / CLAUDE.md rules.
 *
 * @param req      - The incoming Next.js request
 * @param status   - HTTP response status code
 * @param duration - Request duration in milliseconds
 */
export function logRequest(req: NextRequest, status: number, duration: number): void {
  // Extract path only (no query string — could contain PII like search terms)
  const path = req.nextUrl.pathname;
  const method = req.method;

  const entry: RequestLogEntry = {
    timestamp: new Date().toISOString(),
    level: levelFromStatus(status),
    method,
    path,
    status,
    durationMs: Math.round(duration),
    userAgentCategory: categoriseUserAgent(req.headers.get('user-agent')),
  };

  if (isDev) {
    // Pretty dev output: "POST /api/ai/chat 200 142ms"
    const colour = statusColour(status);
    const dur = duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`;
    console.log(
      `${DIM}${entry.timestamp}${RESET} ${method.padEnd(6)} ${path} ${colour}${status}${RESET} ${DIM}${dur}${RESET}`
    );
  } else {
    // Structured JSON for production log aggregation
    console.log(JSON.stringify(entry));
  }
}
