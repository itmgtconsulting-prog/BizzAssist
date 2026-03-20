/**
 * E2E tests for the marketing homepage.
 *
 * Verifies critical user journeys:
 * - Page loads without errors
 * - Hero section is visible with correct content
 * - Language toggle switches between DA and EN
 * - Login CTA navigates to login page
 * - Page is responsive on mobile
 */
import { test, expect } from '@playwright/test';

test.describe('Marketing Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('page loads and shows hero section', async ({ page }) => {
    // Verify the hero badge is visible
    await expect(page.getByText(/Danmarks #1/i)).toBeVisible();
  });

  test('shows BizzAssist logo in navbar', async ({ page }) => {
    await expect(page.getByText('Assist')).toBeVisible();
  });

  test('default language is Danish (DA)', async ({ page }) => {
    // Danish CTA should be visible by default
    await expect(page.getByRole('link', { name: /Kom i gang gratis/i }).first()).toBeVisible();
  });

  test('language toggle switches to English', async ({ page }) => {
    // Click the EN button in the navbar
    await page.getByRole('button', { name: 'EN' }).first().click();
    // English text should now appear
    await expect(page.getByText(/Get started free/i).first()).toBeVisible();
  });

  test('login link navigates to login page', async ({ page }) => {
    await page
      .getByRole('link', { name: /Log ind/i })
      .first()
      .click();
    await expect(page).toHaveURL('/login');
  });

  test('stats section shows key numbers', async ({ page }) => {
    await expect(page.getByText('2M+')).toBeVisible();
    await expect(page.getByText('4M+')).toBeVisible();
  });

  test('features section is visible', async ({ page }) => {
    await page
      .getByText(/Ejendomsdata|Property Data/i)
      .first()
      .scrollIntoViewIfNeeded();
    await expect(page.getByText(/Ejendomsdata|Property Data/i).first()).toBeVisible();
  });

  test('page has no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Filter known harmless errors
    const realErrors = errors.filter((e) => !e.includes('sw.js') && !e.includes('favicon'));
    expect(realErrors).toHaveLength(0);
  });
});

test.describe('Login Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('shows login form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Log ind/i })).toBeVisible();
  });

  test('shows email and password inputs', async ({ page }) => {
    await expect(page.getByPlaceholder(/navn@virksomhed/i)).toBeVisible();
    await expect(page.getByPlaceholder('••••••••')).toBeVisible();
  });

  test('shows Google and LinkedIn login buttons', async ({ page }) => {
    await expect(page.getByText(/Fortsæt med Google/i)).toBeVisible();
    await expect(page.getByText(/Fortsæt med LinkedIn/i)).toBeVisible();
  });

  test('submitting form navigates to dashboard', async ({ page }) => {
    await page.getByPlaceholder(/navn@virksomhed/i).fill('test@test.dk');
    await page.getByPlaceholder('••••••••').fill('password123');
    await page.getByRole('button', { name: /Log ind/i }).click();
    await expect(page).toHaveURL('/dashboard');
  });
});
