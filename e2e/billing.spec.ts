/**
 * E2E tests for billing/subscription.
 *
 * BIZZ-1344: Subscription gate, pro/enterprise badges, token-side.
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping billing tests');
  }
});

test.describe('Billing — tokens', () => {
  test('token-siden loader', async ({ page }) => {
    await page.goto('/dashboard/tokens');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await expect(page.getByText(/Token|API|Nøgle|Key/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
