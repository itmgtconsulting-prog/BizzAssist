/**
 * Playwright auth setup — runs once before authenticated test suites.
 *
 * Logs in with E2E_TEST_EMAIL / E2E_TEST_PASS environment variables,
 * then saves the browser storage state (cookies + localStorage) so
 * authenticated specs can reuse the session without re-logging in.
 *
 * If the env vars are not set the setup is skipped — CI without
 * credentials will only run the public-page specs.
 *
 * Output: .playwright/auth.json (gitignored — never commit session state)
 */
import { test as setup, expect } from '@playwright/test';
import path from 'path';

export const AUTH_STATE_PATH = path.join(process.cwd(), '.playwright', 'auth.json');

setup('authenticate', async ({ page }) => {
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASS;

  if (!email || !password) {
    console.warn(
      '[auth.setup] E2E_TEST_EMAIL / E2E_TEST_PASS not set — skipping authenticated setup.'
    );
    // Write an empty state so dependent projects do not fail trying to load the file
    await page.context().storageState({ path: AUTH_STATE_PATH });
    return;
  }

  // Navigate to login page
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  // Dismiss cookie banner if present
  const cookieAccept = page.getByRole('button', { name: /Accepter/i });
  if (await cookieAccept.isVisible()) {
    await cookieAccept.click();
  }

  // Fill credentials and submit
  await page.getByPlaceholder('navn@virksomhed.dk').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: /Log ind/i }).click();

  // Wait for redirect to dashboard
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

  // Persist auth state
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
