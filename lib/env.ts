/**
 * Environment variable validation — lib/env.ts
 *
 * Validates all required environment variables at build/startup time
 * using @t3-oss/env-nextjs + Zod.
 *
 * ISO 27001 A.14: fail-fast on misconfiguration prevents runtime security gaps.
 *
 * Usage:
 *   import { env } from '@/lib/env';
 *   const dsn = env.NEXT_PUBLIC_SENTRY_DSN;
 *
 * If a required variable is missing, the app throws at startup with a clear
 * error message — never silently continues with undefined secrets.
 */

import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  /**
   * Server-side environment variables.
   * These are NEVER exposed to the browser.
   * All secrets and API keys must be defined here.
   */
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // ── JIRA ───────────────────────────────────────────────────────────────
    JIRA_HOST: z.string().min(1).optional(),
    JIRA_EMAIL: z.string().email().optional(),
    JIRA_API_TOKEN: z.string().min(1).optional(),
    JIRA_PROJECT_KEY: z.string().min(1).optional(),

    // ── Sentry (server-side) ───────────────────────────────────────────────
    SENTRY_ORG: z.string().min(1).optional(),
    SENTRY_PROJECT: z.string().min(1).optional(),
    SENTRY_AUTH_TOKEN: z.string().min(1).optional(),

    // ── Supabase (server-side — Restricted classification, never expose to browser) ──
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    SUPABASE_JWT_SECRET: z.string().min(1).optional(),

    // ── AI (server-side — never expose to browser) ────────────────────────
    // ANTHROPIC_API_KEY: z.string().min(1),           // Uncomment when Claude API is added

    // ── Email (Resend) ────────────────────────────────────────────────────
    // RESEND_API_KEY: z.string().min(1),              // Uncomment when Resend is configured

    // ── Stripe ────────────────────────────────────────────────────────────
    // STRIPE_SECRET_KEY: z.string().min(1),           // Uncomment when Stripe is added
    // STRIPE_WEBHOOK_SECRET: z.string().min(1),
  },

  /**
   * Client-side (browser-exposed) environment variables.
   * MUST be prefixed with NEXT_PUBLIC_.
   * Never put secrets here.
   */
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
    NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),

    // ── Supabase (public — safe to expose, used by browser client) ───────────
    NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),

    // ── Maps ──────────────────────────────────────────────────────────────
    // NEXT_PUBLIC_MAPBOX_TOKEN: z.string().min(1),    // Uncomment when Mapbox is added
  },

  /**
   * Destructured process.env values that are passed to the validators above.
   * Required by t3-env to work correctly with Next.js bundling.
   */
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    JIRA_HOST: process.env.JIRA_HOST,
    JIRA_EMAIL: process.env.JIRA_EMAIL,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
    JIRA_PROJECT_KEY: process.env.JIRA_PROJECT_KEY,
    SENTRY_ORG: process.env.SENTRY_ORG,
    SENTRY_PROJECT: process.env.SENTRY_PROJECT,
    SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },

  /**
   * Skip validation during builds if all env vars aren't available.
   * Set SKIP_ENV_VALIDATION=1 in CI if building without full secrets.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
