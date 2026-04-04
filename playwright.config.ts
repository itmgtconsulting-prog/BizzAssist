import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for BizzAssist end-to-end tests.
 *
 * E2E tests verify critical public-facing user journeys:
 *  - Marketing homepage rendering and language toggle
 *  - Login page UI and form validation
 *  - Support chat widget interaction
 *  - Basic navigation between pages
 *
 * Run: npm run test:e2e
 * UI mode: npm run test:e2e:ui
 */
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

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

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
