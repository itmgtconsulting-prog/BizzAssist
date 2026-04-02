/**
 * E2E tests for basic navigation between public pages.
 *
 * Verifies:
 *  - Homepage to login page navigation
 *  - Login page renders after navigation
 *  - Back to homepage from login page
 *  - Direct URL navigation works
 */
import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss the cookie banner so it does not block clicks
    await page.addInitScript(() => {
      localStorage.setItem('cookie_consent', 'accepted');
    });
  });

  /* ── Homepage to Login ─────────────────────────────────────────── */

  test('navigating from homepage to login via navbar link', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const loginLink = page.locator('header a[href="/login"]').first();
    await expect(loginLink).toBeVisible();
    await loginLink.click();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /Log ind/i })).toBeVisible();
  });

  test('navigating from homepage to signup via CTA button', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page
      .getByRole('link', { name: /Kom i gang gratis/i })
      .first()
      .click();
    await expect(page).toHaveURL('/login/signup', { timeout: 10_000 });
  });

  /* ── Login page renders ────────────────────────────────────────── */

  test('login page renders with form elements after direct navigation', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByPlaceholder('navn@virksomhed.dk')).toBeVisible();
    await expect(page.getByPlaceholder('••••••••')).toBeVisible();
    await expect(page.getByRole('button', { name: /Log ind/i })).toBeVisible();
  });

  /* ── Back to homepage ──────────────────────────────────────────── */

  test('login page back link navigates to homepage', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    const backLink = page.locator('a[href="/"]').first();
    await expect(backLink).toBeVisible();
    await backLink.click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });
    await expect(page.getByText('BizzAssist').first()).toBeVisible();
  });

  test('browser back button works after navigating to login', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const loginLink = page.locator('header a[href="/login"]').first();
    await expect(loginLink).toBeVisible();
    await loginLink.click();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    await page.goBack();
    await expect(page).toHaveURL('/', { timeout: 10_000 });
  });

  /* ── Auth guard redirect ───────────────────────────────────────── */

  test('accessing /dashboard without auth redirects to /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});
