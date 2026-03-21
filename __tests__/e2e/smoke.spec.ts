/**
 * Smoke tests — "er systemet klar til test?"
 *
 * Kør: npm run test:smoke
 *
 * Disse tests verificerer at alle kritiske dele af applikationen
 * er oppe og tilgængelige FØR man melder klar til test. De kræver
 * ingen autentificering og kører på under 30 sekunder.
 *
 * ✅ Pass = systemet er klar til test
 * ❌ Fail = noget er nede — løs problemet inden test begynder
 */
import { test, expect } from '@playwright/test';

// ── 1. Health check ──────────────────────────────────────────────────────────

test.describe('Health check', () => {
  test('GET /api/health returns 200 and status ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.api).toBe('ok');
  });
});

// ── 2. Critical pages load ───────────────────────────────────────────────────

test.describe('Critical pages load without errors', () => {
  test('homepage (/) renders', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    const res = await page.goto('/');
    expect(res?.status()).toBeLessThan(400);

    // Page title or logo must be present
    await expect(page.getByText('BizzAssist').first()).toBeVisible();

    // No unexpected console errors
    const realErrors = errors.filter(
      (e) => !e.includes('sw.js') && !e.includes('favicon') && !e.includes('manifest')
    );
    expect(realErrors).toHaveLength(0);
  });

  test('/login renders login form', async ({ page }) => {
    const res = await page.goto('/login');
    expect(res?.status()).toBeLessThan(400);

    // Login heading must be visible
    await expect(page.getByRole('heading', { name: /log ind/i })).toBeVisible();

    // Form inputs present
    await expect(page.getByRole('textbox', { name: /e-mail/i })).toBeVisible();
  });

  test('/login/signup renders signup form', async ({ page }) => {
    const res = await page.goto('/login/signup');
    expect(res?.status()).toBeLessThan(400);

    await expect(page.getByRole('heading', { name: /opret konto/i })).toBeVisible();
  });

  test('/login/forgot-password renders reset form', async ({ page }) => {
    const res = await page.goto('/login/forgot-password');
    expect(res?.status()).toBeLessThan(400);

    // Should have an email input for password reset
    await expect(page.getByRole('textbox', { name: /e-mail/i })).toBeVisible();
  });
});

// ── 3. Auth guard works ──────────────────────────────────────────────────────

test.describe('Auth guard', () => {
  test('/dashboard redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/dashboard');
    // Should end up on /login (with optional ?redirectTo param)
    await expect(page).toHaveURL(/\/login/);
  });
});

// ── 4. Key UI elements ───────────────────────────────────────────────────────

test.describe('Key UI elements', () => {
  test('homepage has DA/EN language toggle', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'DA' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'EN' }).first()).toBeVisible();
  });

  test('language toggle switches homepage to English', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'EN' }).first().click();
    await expect(page.getByText(/get started free/i).first()).toBeVisible();
  });

  test('login page has Google OAuth button', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText(/fortsæt med google/i)).toBeVisible();
  });
});
