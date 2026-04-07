/**
 * E2E tests for the login page (/login).
 *
 * Tests public-facing login UI only — no actual authentication.
 * Verifies:
 *  - Login form renders with email/password fields
 *  - Language toggle works on login page
 *  - Google and LinkedIn OAuth buttons are visible
 *  - Form validation (required fields prevent empty submit)
 *  - Signup link navigates to the signup page
 */
import { test, expect } from '@playwright/test';

test.describe('Login page', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss the cookie banner so it does not block clicks
    await page.addInitScript(() => {
      localStorage.setItem('cookie_consent', 'accepted');
    });
    await page.goto('/login');
  });

  /* ── Form rendering ────────────────────────────────────────────── */

  test('login form renders with heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Log ind på BizzAssist/i })).toBeVisible();
  });

  test('email input is visible with correct placeholder', async ({ page }) => {
    const emailInput = page.getByPlaceholder('navn@virksomhed.dk');
    await expect(emailInput).toBeVisible();
    await expect(emailInput).toHaveAttribute('type', 'email');
  });

  test('password input is visible', async ({ page }) => {
    const passwordInput = page.getByPlaceholder('••••••••');
    await expect(passwordInput).toBeVisible();
    await expect(passwordInput).toHaveAttribute('type', 'password');
  });

  test('login submit button is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Log ind/i })).toBeVisible();
  });

  /* ── Language toggle ───────────────────────────────────────────── */

  test('language toggle switches login page to English', async ({ page }) => {
    // Login page has its own language toggle in the top bar
    await page.getByRole('button', { name: 'EN' }).first().click();
    await expect(page.getByRole('heading', { name: /Log in to BizzAssist/i })).toBeVisible();
    await expect(page.getByPlaceholder('name@company.com')).toBeVisible();
  });

  test('language toggle switches back to Danish', async ({ page }) => {
    await page.getByRole('button', { name: 'EN' }).first().click();
    await page.getByRole('button', { name: 'DA' }).first().click();
    await expect(page.getByRole('heading', { name: /Log ind på BizzAssist/i })).toBeVisible();
  });

  /* ── OAuth buttons ─────────────────────────────────────────────── */

  test('Google OAuth button is visible', async ({ page }) => {
    await expect(page.getByText(/Fortsæt med Google/i)).toBeVisible();
  });

  test('Microsoft OAuth button is visible', async ({ page }) => {
    await expect(page.getByText(/Fortsæt med Microsoft/i)).toBeVisible();
  });

  /* ── Form validation ───────────────────────────────────────────── */

  test('submitting empty form does not navigate away', async ({ page }) => {
    await page.getByRole('button', { name: /Log ind/i }).click();
    // HTML5 required validation prevents submission — we stay on /login
    await expect(page).toHaveURL(/\/login/);
  });

  test('email field has required attribute', async ({ page }) => {
    const emailInput = page.getByPlaceholder('navn@virksomhed.dk');
    await expect(emailInput).toHaveAttribute('required', '');
  });

  test('password field has required attribute', async ({ page }) => {
    const passwordInput = page.getByPlaceholder('••••••••');
    await expect(passwordInput).toHaveAttribute('required', '');
  });

  /* ── Navigation links ──────────────────────────────────────────── */

  test('signup link navigates to /login/signup', async ({ page }) => {
    const signupLink = page.locator('a[href="/login/signup"]').first();
    await expect(signupLink).toBeVisible({ timeout: 5_000 });
    await signupLink.click({ force: true });
    await expect(page).toHaveURL(/\/login\/signup/, { timeout: 10_000 });
  });

  test('forgot password link is visible', async ({ page }) => {
    await expect(page.getByRole('link', { name: /Glemt adgangskode/i })).toBeVisible();
  });

  test('back arrow link navigates to homepage', async ({ page }) => {
    const backLink = page.locator('a[href="/"]').first();
    await expect(backLink).toBeVisible();
    await backLink.click();
    await expect(page).toHaveURL('/');
  });
});
