/**
 * Shared E2E helpers — imported by spec files.
 * Not a test file itself (no describe/test blocks).
 */
import path from 'path';
import type { Page } from '@playwright/test';

/** Path where auth.setup.ts saves the Supabase session state. */
export const AUTH_STATE_PATH = path.join(process.cwd(), '.playwright', 'auth.json');

/**
 * Dismisses the onboarding modal if it is visible on the page.
 * Steps through up to 5 "Næste" screens and falls back to a close button.
 *
 * @param page - Playwright page instance
 */
export async function dismissOnboarding(page: Page): Promise<void> {
  // Step through paginated onboarding screens
  const nextBtn = page.getByRole('button', { name: /Næste|Next|Kom i gang|Fortsæt|Skip/i }).first();
  for (let i = 0; i < 5; i++) {
    if (await nextBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await nextBtn.click();
    } else {
      break;
    }
  }
  // Fall back: close/X button inside the dialog
  const closeBtn = page
    .locator(
      '[role="dialog"] button[aria-label*="Luk"], [role="dialog"] button[aria-label*="Close"]'
    )
    .first();
  if (await closeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeBtn.click();
  }
}
