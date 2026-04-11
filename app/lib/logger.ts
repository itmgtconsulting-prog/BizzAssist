/**
 * Application Logger — BIZZ-207
 *
 * Provides a structured logging interface for both server-side API routes
 * and client-side components. Replaces bare console.log/warn/error calls
 * throughout the codebase.
 *
 * Behaviour by environment:
 *   - development : log/warn/error all write to stdout/stderr (unchanged)
 *   - production  : log + warn are no-ops; error always writes to stderr
 *
 * ISO 27001 A.12.4 — Logging and Monitoring:
 *   Never log PII (names, emails, IP addresses, user IDs, passwords).
 *   Use opaque identifiers or boolean flags instead.
 *
 * Usage:
 * ```ts
 * import { logger } from '@/app/lib/logger';
 *
 * logger.log('[my-module] operation completed', { count: 3 });
 * logger.warn('[my-module] unexpected state');
 * logger.error('[my-module] fetch failed:', err);
 * ```
 *
 * @module app/lib/logger
 */

// Evaluated once at module load — no runtime branch on hot path.
const isDev = process.env.NODE_ENV === 'development';

function noop(..._args: unknown[]): void {}

/**
 * Application-wide logger.
 *
 * @property log   - Diagnostic messages. No-op in production.
 * @property warn  - Warnings. No-op in production.
 * @property error - Errors. Always writes to stderr in all environments.
 */
export const logger = {
  /**
   * Diagnostic / informational log. No-op in production.
   *
   * @param args - Message and optional extra values
   */
  log: isDev
    ? (...args: unknown[]): void => {
        console.log(...args);
      }
    : noop,

  /**
   * Warning log. No-op in production.
   *
   * @param args - Message and optional extra values
   */
  warn: isDev
    ? (...args: unknown[]): void => {
        console.warn(...args);
      }
    : noop,

  /**
   * Error log. Always writes to stderr regardless of environment.
   * For production, Sentry captures errors via the error boundary.
   *
   * @param args - Message and optional extra values
   */
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};
