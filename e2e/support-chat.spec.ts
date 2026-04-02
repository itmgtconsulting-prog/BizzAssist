/**
 * E2E tests for the support chat widget (SupportChatWidget).
 *
 * The widget is a floating chat bubble rendered on all pages.
 * Tests verify:
 *  - Chat bubble is visible on the login page
 *  - Opens on click revealing the chat panel
 *  - Greeting message is displayed on open
 *  - Can type a message in the input field
 *  - Can close the chat panel
 */
import { test, expect } from '@playwright/test';

test.describe('Support chat widget', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss the cookie banner so it does not block clicks
    await page.addInitScript(() => {
      localStorage.setItem('cookie_consent', 'accepted');
    });
    await page.goto('/login');
    // Wait for the page to fully hydrate
    await page.waitForLoadState('networkidle');
  });

  /* ── Visibility ────────────────────────────────────────────────── */

  test('chat bubble is visible on login page', async ({ page }) => {
    const bubble = page.locator('button[aria-label="Support"]');
    await expect(bubble).toBeVisible();
  });

  /* ── Opening the chat ──────────────────────────────────────────── */

  test('clicking the bubble opens the chat panel', async ({ page }) => {
    await page.locator('button[aria-label="Support"]').click();
    // The panel header with "Support" title should appear
    const panelTitle = page.locator('h3').filter({ hasText: 'Support' });
    await expect(panelTitle).toBeVisible();
  });

  test('greeting message appears when chat opens', async ({ page }) => {
    await page.locator('button[aria-label="Support"]').click();
    // The greeting contains "BizzAssist" in the DA version
    await expect(page.getByText(/BizzAssists support-assistent/i)).toBeVisible();
  });

  /* ── Typing a message ──────────────────────────────────────────── */

  test('can type in the chat input field', async ({ page }) => {
    await page.locator('button[aria-label="Support"]').click();
    const input = page.getByPlaceholder(/Skriv dit spørgsmål/i);
    await expect(input).toBeVisible();
    await input.fill('Hej, jeg har et spørgsmål');
    await expect(input).toHaveValue('Hej, jeg har et spørgsmål');
  });

  test('send button is visible when chat is open', async ({ page }) => {
    await page.locator('button[aria-label="Support"]').click();
    const sendBtn = page.locator('button[aria-label="Send"]');
    await expect(sendBtn).toBeVisible();
  });

  /* ── Bug report button ─────────────────────────────────────────── */

  test('bug report button is visible in chat panel', async ({ page }) => {
    await page.locator('button[aria-label="Support"]').click();
    await expect(page.getByText(/Rapportér fejl/i)).toBeVisible();
  });

  /* ── Closing the chat ──────────────────────────────────────────── */

  test('clicking the bubble again closes the chat panel', async ({ page }) => {
    // Open
    await page.locator('button[aria-label="Support"]').click();
    const panelTitle = page.locator('h3').filter({ hasText: 'Support' });
    await expect(panelTitle).toBeVisible();

    // Close — the bubble button still has aria-label "Support" (localized title)
    await page.locator('button[aria-label="Support"]').click();
    await expect(panelTitle).not.toBeVisible();
  });
});
