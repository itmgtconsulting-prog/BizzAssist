/**
 * E2E tests for the marketing homepage (/).
 *
 * Tests public-facing content only — no authentication required.
 * Verifies:
 *  - Page loads with correct title/branding
 *  - Hero section visible with CTA button
 *  - Navigation links render and work
 *  - Language toggle switches DA/EN
 *  - Footer renders with expected content
 */
import { test, expect } from '@playwright/test';

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss the cookie banner so it does not block clicks
    await page.addInitScript(() => {
      localStorage.setItem('cookie_consent', 'accepted');
    });
    await page.goto('/');
  });

  /* ── Page load ─────────────────────────────────────────────────── */

  test('page loads with BizzAssist branding', async ({ page }) => {
    await expect(page.getByText('BizzAssist').first()).toBeVisible();
  });

  test('page has no unexpected console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Filter known harmless errors (service worker, favicon, Supabase auth 401s)
    const realErrors = errors.filter(
      (e) =>
        !e.includes('sw.js') &&
        !e.includes('favicon') &&
        !e.includes('manifest') &&
        !e.includes('401')
    );
    expect(realErrors).toHaveLength(0);
  });

  /* ── Hero section ──────────────────────────────────────────────── */

  test('hero section is visible with Danish headline', async ({ page }) => {
    await expect(page.getByText('Data og Information om')).toBeVisible();
  });

  test('hero CTA button links to signup', async ({ page }) => {
    const cta = page.getByRole('link', { name: /Kom i gang gratis/i }).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '/login/signup');
  });

  /* ── Navigation links ──────────────────────────────────────────── */

  test('navbar has Features and Use Cases links', async ({ page }) => {
    // These are <a> tags with href="#features" and href="#use-cases"
    await expect(page.locator('a[href="#features"]').first()).toBeVisible();
    await expect(page.locator('a[href="#use-cases"]').first()).toBeVisible();
  });

  test('navbar Log ind link navigates to /login', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const loginLink = page.locator('header a[href="/login"]').first();
    await expect(loginLink).toBeVisible();
    await loginLink.click();
    await expect(page).toHaveURL(/\/login/);
  });

  /* ── Language toggle ───────────────────────────────────────────── */

  test('language toggle buttons DA/EN are visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'DA' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'EN' }).first()).toBeVisible();
  });

  test('clicking EN switches page to English', async ({ page }) => {
    await page.getByRole('button', { name: 'EN' }).first().click();
    await expect(page.getByText('Know everything about')).toBeVisible();
    await expect(page.getByText(/Get started free/i).first()).toBeVisible();
  });

  test('clicking DA after EN switches back to Danish', async ({ page }) => {
    await page.getByRole('button', { name: 'EN' }).first().click();
    await expect(page.getByText('Know everything about')).toBeVisible();
    await page.getByRole('button', { name: 'DA' }).first().click();
    await expect(page.getByText('Data og Information om')).toBeVisible();
  });

  /* ── Footer ────────────────────────────────────────────────────── */

  test('footer renders with copyright and supplier info', async ({ page }) => {
    const footer = page.locator('footer');
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();
    await expect(footer.getByText(/BizzAssist/i).first()).toBeVisible();
    await expect(footer.getByText('Pecunia IT ApS')).toBeVisible();
  });

  test('footer contains product and legal sections', async ({ page }) => {
    const footer = page.locator('footer');
    await footer.scrollIntoViewIfNeeded();
    await expect(footer.getByText('Produkt')).toBeVisible();
    await expect(footer.getByText('Juridisk')).toBeVisible();
  });
});
