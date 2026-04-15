/**
 * Playwright auth setup — runs once before authenticated test suites.
 *
 * Logs in with E2E_TEST_EMAIL / E2E_TEST_PASS environment variables,
 * then saves the browser storage state (cookies + localStorage) so
 * authenticated specs can reuse the session without re-logging in.
 *
 * Also dismisses the onboarding modal (if shown on first login) so
 * the saved state has no modal blocking subsequent test interactions.
 *
 * If the env vars are not set the setup is skipped — CI without
 * credentials will only run the public-page specs.
 *
 * Output: .playwright/auth.json (gitignored — never commit session state)
 */
import { test as setup, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { AUTH_STATE_PATH } from './helpers';

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
  await page.waitForLoadState('domcontentloaded');

  // Dismiss cookie banner if present (button text includes "Acceptér" with accent)
  const cookieAccept = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await cookieAccept.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await cookieAccept.click();
  }

  // Fill credentials and submit
  await page.getByPlaceholder('navn@virksomhed.dk').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: /Log ind/i }).click();

  // Wait for redirect — could be /dashboard or /onboarding
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/, { timeout: 30_000 });
  await page.waitForLoadState('domcontentloaded');

  // Set onboarding_complete via Supabase admin client (Node.js, not browser).
  // Uses service role key to bypass RLS and set user_metadata directly.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && serviceRoleKey && email) {
    try {
      const admin = createClient(supabaseUrl, serviceRoleKey);
      // Find user by email
      const {
        data: { users },
      } = await admin.auth.admin.listUsers();
      const user = users?.find((u) => u.email === email);
      if (user && !user.user_metadata?.onboarding_complete) {
        await admin.auth.admin.updateUserById(user.id, {
          user_metadata: { ...user.user_metadata, onboarding_complete: true },
        });
      }
    } catch {
      /* non-fatal — onboarding page will handle */
    }
  }

  // Handle onboarding PAGE redirect — navigate directly to dashboard
  if (page.url().includes('/onboarding')) {
    await page.goto('/dashboard');
  }
  await page.waitForLoadState('domcontentloaded');

  // Handle onboarding MODAL (if it appears on the dashboard itself)
  const onboardingNext = page
    .getByRole('button', { name: /Næste|Next|Kom i gang|Fortsæt/i })
    .first();
  for (let i = 0; i < 5; i++) {
    if (await onboardingNext.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await onboardingNext.click();
      await page.waitForTimeout(500);
    } else {
      break;
    }
  }
  const onboardingClose = page
    .locator(
      '[role="dialog"] button[aria-label*="Luk"], [role="dialog"] button[aria-label*="Close"]'
    )
    .first();
  if (await onboardingClose.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await onboardingClose.click();
  }

  // Persist auth state — includes dismissed modal state in localStorage
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
