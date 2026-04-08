import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { config as loadDotenv } from 'dotenv';

// Load .env.local so E2E_TEST_EMAIL / E2E_TEST_PASS are available to the test runner
loadDotenv({ path: path.join(process.cwd(), '.env.local') });

/**
 * Playwright configuration for BizzAssist end-to-end tests.
 *
 * Two project tiers:
 *
 *  1. Public-page tests (no auth required):
 *     - homepage, login page, navigation, support chat
 *
 *  2. Authenticated tests (require E2E_TEST_EMAIL / E2E_TEST_PASS):
 *     - dashboard search → property/company detail
 *     - settings GDPR export + delete-account UI
 *     - AI chat panel
 *     These depend on the "auth setup" project which logs in once and saves
 *     browser storage state to .playwright/auth.json.
 *
 * Run all:            npm run test:e2e
 * UI mode:            npm run test:e2e:ui
 * Public only (CI):   npx playwright test --project=chromium-public
 */

const AUTH_STATE_PATH = path.join(process.cwd(), '.playwright', 'auth.json');

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  timeout: 45_000,

  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    /* ── Auth setup — runs once, produces .playwright/auth.json ── */
    {
      name: 'auth setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },

    /* ── Public pages — no auth required ── */
    {
      name: 'chromium-public',
      testMatch: /\/(homepage|login|navigation|support-chat)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },

    /* ── Authenticated pages — depend on auth setup ── */
    {
      name: 'chromium-auth',
      testMatch: /\/(dashboard|settings-gdpr|ai-chat)\.spec\.ts/,
      dependencies: ['auth setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_STATE_PATH,
      },
    },
  ],

  /* Start the Next.js dev server automatically before tests */
  webServer: {
    command: 'npm run dev',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    // Increase timeout for CI — Next.js Turbopack can take 90–120 s on cold start
    timeout: 120_000,
    env: {
      // Provide placeholder Supabase credentials so the browser client can
      // initialise without throwing "Invalid URL" errors during public-page tests.
      // These are never used for actual DB calls in the public-page E2E suite.
      NEXT_PUBLIC_SUPABASE_URL:
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder-ci.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY:
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-anon-key-ci',
    },
  },
});
