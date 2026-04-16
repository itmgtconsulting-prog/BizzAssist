/**
 * Centralized application configuration — app/lib/config.ts
 *
 * Extracts hardcoded rate limits, timeouts, and cache TTLs into a single
 * importable module. Values can be overridden via environment variables
 * for runtime tunability without code changes.
 *
 * BIZZ-416: Rate limits and timeouts
 * BIZZ-417: Cache TTLs
 *
 * @module app/lib/config
 */

// ─── Rate Limits ────────────────────────────────────────────────────────────

/** General API rate limit (requests per 10-second window) */
export const RATE_LIMIT_GENERAL = parseInt(process.env.RATE_LIMIT_GENERAL ?? '500', 10);

/** Heavy API rate limit (requests per 10-second window) */
export const RATE_LIMIT_HEAVY = parseInt(process.env.RATE_LIMIT_HEAVY ?? '200', 10);

/** AI chat rate limit (requests per minute) */
export const RATE_LIMIT_AI = parseInt(process.env.RATE_LIMIT_AI ?? '10', 10);

/** Brave Search rate limit (requests per day) */
export const RATE_LIMIT_BRAVE = parseInt(process.env.RATE_LIMIT_BRAVE ?? '500', 10);

// ─── Timeouts (milliseconds) ────────────────────────────────────────────────

/** Default external API fetch timeout */
export const TIMEOUT_DEFAULT = parseInt(process.env.TIMEOUT_DEFAULT ?? '10000', 10);

/** Heavy external API timeout (tinglysning, ejerskab) */
export const TIMEOUT_HEAVY = parseInt(process.env.TIMEOUT_HEAVY ?? '30000', 10);

/** Vercel max function duration for standard routes (seconds) */
export const MAX_DURATION_DEFAULT = parseInt(process.env.MAX_DURATION_DEFAULT ?? '30', 10);

/** Vercel max function duration for heavy routes (seconds) */
export const MAX_DURATION_HEAVY = parseInt(process.env.MAX_DURATION_HEAVY ?? '60', 10);

// ─── Cache TTLs (seconds) ───────────────────────────────────────────────────

/** Short-lived cache: status checks, bbox queries (60s) */
export const CACHE_TTL_SHORT = parseInt(process.env.CACHE_TTL_SHORT ?? '60', 10);

/** Medium cache: search results, CVR data (300s = 5 min) */
export const CACHE_TTL_MEDIUM = parseInt(process.env.CACHE_TTL_MEDIUM ?? '300', 10);

/** Standard cache: company data, ejerskab (1800s = 30 min) */
export const CACHE_TTL_STANDARD = parseInt(process.env.CACHE_TTL_STANDARD ?? '1800', 10);

/** Long cache: property data, energy labels, regnskab (3600s = 1 hour) */
export const CACHE_TTL_LONG = parseInt(process.env.CACHE_TTL_LONG ?? '3600', 10);

/** Extended cache: matrikel, vurdering, jordforurening (86400s = 24 hours) */
export const CACHE_TTL_EXTENDED = parseInt(process.env.CACHE_TTL_EXTENDED ?? '86400', 10);

/** Stale-while-revalidate: short (30s) */
export const SWR_SHORT = parseInt(process.env.SWR_SHORT ?? '120', 10);

/** Stale-while-revalidate: standard (600s = 10 min) */
export const SWR_STANDARD = parseInt(process.env.SWR_STANDARD ?? '600', 10);

/** Stale-while-revalidate: long (3600s = 1 hour) */
export const SWR_LONG = parseInt(process.env.SWR_LONG ?? '3600', 10);
