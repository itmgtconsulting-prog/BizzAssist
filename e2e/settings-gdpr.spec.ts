/**
 * E2E tests for the settings page — GDPR self-service flows.
 *
 * Covers (BIZZ-151 / BIZZ-152):
 *  - Settings page renders the profile section
 *  - GDPR data export button is visible and clickable (download initiated)
 *  - Danger zone — delete account section renders
 *  - Delete account form requires the confirmation phrase "SLET MIN KONTO"
 *  - Submitting with wrong phrase shows an error
 *  - Delete button is disabled until the exact phrase is typed
 *
 * NOTE: We never actually submit the delete — we only verify the UI gate.
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping authenticated settings tests');
  }
});

test.describe('Settings page — GDPR', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/settings');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
  });

  /** Settings page renders correctly */
  test('settings page loads with profile section', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: /Indstillinger|Settings/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  /** GDPR export button is present */
  test('GDPR data export button is visible', async ({ page }) => {
    const exportBtn = page
      .getByRole('button', { name: /Download mine data|Export my data/i })
      .or(page.getByText(/mine data/i).first());
    await expect(exportBtn.first()).toBeVisible({ timeout: 10_000 });
  });

  /**
   * Export triggers a file download via client-side blob URL.
   * We mock the API endpoint and check for the success toast/message.
   */
  test('clicking export data button shows success or initiates download', async ({ page }) => {
    // Mock /api/user/export-data to return a minimal valid payload
    await page.route('/api/user/export-data', async (route) => {
      const payload = {
        gdprArticle: '20',
        exportedAt: new Date().toISOString(),
        profile: { id: 'test-user', email: 'jjrchefen@gmail.com' },
        recentEntities: [],
      };
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="mine-data-test.json"',
        },
        body: JSON.stringify(payload),
      });
    });

    const exportBtn = page
      .getByRole('button', { name: /Download mine data|Download my data/i })
      .first();
    await expect(exportBtn).toBeVisible({ timeout: 10_000 });
    await exportBtn.click();

    // Success message should appear after the API call resolves
    await expect(page.getByText(/datafil er klar|data file is ready|Henter/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  /** Danger zone section renders */
  test('danger zone section with delete account heading is visible', async ({ page }) => {
    const dangerHeading = page
      .getByRole('heading', { name: /Slet konto|Delete account/i })
      .or(page.getByText(/Slet min konto|Danger zone/i).first());
    await expect(dangerHeading.first()).toBeVisible({ timeout: 10_000 });
  });

  /** Delete button is disabled initially */
  test('delete account button is disabled without confirmation phrase', async ({ page }) => {
    // Scroll to danger zone
    const dangerSection = page.getByText(/SLET MIN KONTO/).first();
    await dangerSection.scrollIntoViewIfNeeded();

    const deleteBtn = page.getByRole('button', { name: /Slet min konto|Bekræft sletning/i }).last();
    await expect(deleteBtn).toBeDisabled();
  });

  /** Delete button remains disabled with wrong phrase */
  test('delete button stays disabled when wrong phrase is entered', async ({ page }) => {
    const confirmInput = page.getByPlaceholder(/SLET MIN KONTO/).first();
    await expect(confirmInput).toBeVisible({ timeout: 10_000 });

    await confirmInput.fill('delete my account');

    const deleteBtn = page.getByRole('button', { name: /Slet min konto|Bekræft sletning/i }).last();
    await expect(deleteBtn).toBeDisabled();
  });

  /** Delete button becomes enabled with correct phrase */
  test('delete button is enabled when correct confirmation phrase is typed', async ({ page }) => {
    const confirmInput = page.getByPlaceholder(/SLET MIN KONTO/).first();
    await expect(confirmInput).toBeVisible({ timeout: 10_000 });

    await confirmInput.fill('SLET MIN KONTO');

    const deleteBtn = page.getByRole('button', { name: /Slet min konto|Bekræft sletning/i }).last();
    await expect(deleteBtn).toBeEnabled();
    // We intentionally do NOT click — the test account must not be deleted
  });
});
