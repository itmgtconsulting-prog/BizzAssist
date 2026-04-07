/**
 * E2E tests for the AI chat panel (AIChatPanel).
 *
 * Covers:
 *  - AI chat toggle button is visible on dashboard
 *  - Opening the panel shows the chat interface
 *  - User can type a message in the input field
 *  - Sending a message shows a loading/typing indicator
 *  - Panel can be closed
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 * The AI API itself is not invoked in full — we only verify the UI layer.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './auth.setup';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping authenticated AI chat tests');
  }
});

test.describe('AI chat panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
  });

  /** Toggle button is visible */
  test('AI chat toggle button is visible on dashboard', async ({ page }) => {
    // The AI panel is toggled by a button — look for the Bizzness Assistent label
    const chatToggle = page
      .getByRole('button', { name: /Bizzness Assistent|AI chat|Assistent/i })
      .or(page.locator('button[aria-label*="Assistent"]'))
      .first();
    await expect(chatToggle).toBeVisible({ timeout: 15_000 });
  });

  /** Opening the panel shows the chat interface */
  test('clicking AI toggle opens the chat panel', async ({ page }) => {
    const chatToggle = page
      .getByRole('button', { name: /Bizzness Assistent|AI chat|Assistent/i })
      .or(page.locator('button[aria-label*="Assistent"]'))
      .first();
    await chatToggle.click();

    // Chat input should appear
    const chatInput = page.getByPlaceholder(/Stil et spørgsmål|Skriv en besked|Ask/i).first();
    await expect(chatInput).toBeVisible({ timeout: 10_000 });
  });

  /** User can type in the input */
  test('user can type a message in the AI chat input', async ({ page }) => {
    const chatToggle = page
      .getByRole('button', { name: /Bizzness Assistent|AI chat|Assistent/i })
      .or(page.locator('button[aria-label*="Assistent"]'))
      .first();
    await chatToggle.click();

    const chatInput = page.getByPlaceholder(/Stil et spørgsmål|Skriv en besked|Ask/i).first();
    await expect(chatInput).toBeVisible({ timeout: 10_000 });

    await chatInput.fill('Hvad er BBR?');
    await expect(chatInput).toHaveValue('Hvad er BBR?');
  });

  /** Send button is present */
  test('send button is visible when chat panel is open', async ({ page }) => {
    const chatToggle = page
      .getByRole('button', { name: /Bizzness Assistent|AI chat|Assistent/i })
      .or(page.locator('button[aria-label*="Assistent"]'))
      .first();
    await chatToggle.click();

    const sendBtn = page
      .getByRole('button', { name: /Send/i })
      .or(page.locator('button[aria-label="Send"]'))
      .first();
    await expect(sendBtn).toBeVisible({ timeout: 10_000 });
  });

  /** Sending a message shows a thinking indicator */
  test('sending a message shows thinking/streaming indicator', async ({ page }) => {
    // Mock the AI stream endpoint so we don't actually call Claude API in tests
    await page.route('/api/ai/chat', async (route) => {
      // Return a minimal SSE stream with one chunk and done
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: [
          'data: {"type":"text","text":"BBR er Bygnings- og Boligregistret."}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
      });
    });

    const chatToggle = page
      .getByRole('button', { name: /Bizzness Assistent|AI chat|Assistent/i })
      .or(page.locator('button[aria-label*="Assistent"]'))
      .first();
    await chatToggle.click();

    const chatInput = page.getByPlaceholder(/Stil et spørgsmål|Skriv en besked|Ask/i).first();
    await expect(chatInput).toBeVisible({ timeout: 10_000 });
    await chatInput.fill('Hvad er BBR?');

    const sendBtn = page
      .getByRole('button', { name: /Send/i })
      .or(page.locator('button[aria-label="Send"]'))
      .first();
    await sendBtn.click();

    // After send the input should be cleared or disabled while streaming
    // Either a loading spinner or the assistant's response text appears
    const response = page.getByText(/BBR er|Tænker|Loading/i).first();
    await expect(response).toBeVisible({ timeout: 15_000 });
  });

  /** Panel can be closed */
  test('AI chat panel can be closed', async ({ page }) => {
    const chatToggle = page
      .getByRole('button', { name: /Bizzness Assistent|AI chat|Assistent/i })
      .or(page.locator('button[aria-label*="Assistent"]'))
      .first();
    await chatToggle.click();

    const chatInput = page.getByPlaceholder(/Stil et spørgsmål|Skriv en besked|Ask/i).first();
    await expect(chatInput).toBeVisible({ timeout: 10_000 });

    // Click the close button (X) inside the panel
    const closeBtn = page
      .getByRole('button', { name: /Luk|Close/i })
      .or(page.locator('[aria-label="Luk"]'))
      .first();
    await closeBtn.click();

    await expect(chatInput).not.toBeVisible({ timeout: 5_000 });
  });
});
