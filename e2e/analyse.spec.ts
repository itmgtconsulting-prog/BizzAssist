/**
 * E2E tests for the Analyse modules (/dashboard/analyse/*).
 *
 * Covers all 9 branch modules + landing page + AI Analyse + Data Analyse.
 * Each module has ≥ 3 tests verifying page load, interaction, and data delivery.
 *
 * Real-world test data:
 *  - CVR 10150817 (COOP Danmark A/S)
 *  - CVR 25313763 (Danske Bank A/S)
 *  - BFE 5764389 (known property)
 *  - EnhedsNummer 4000115446 (known person)
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 * Runs serially to avoid rate limiting on test environment.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

/* ── Skip if no auth ────────────────────────────────────────────────────── */
test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping authenticated analyse tests');
  }
});

/* ── Timeouts — AI streaming can take a while ───────────────────────────── */
test.setTimeout(90_000);

/**
 * Helper: navigate to an analyse module page and wait for it to fully load.
 * Dismisses onboarding and waits for the SubscriptionGate / access check.
 */
async function gotoAnalyseModule(page: import('@playwright/test').Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');
  await dismissOnboarding(page);
  // Wait for "Kontrollerer adgang..." spinner to disappear (AnalyseModuleGuard)
  const accessSpinner = page.getByText(/Kontrollerer adgang/i);
  if (await accessSpinner.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await accessSpinner.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  }
}

/**
 * Helper: check if SubscriptionGate is blocking access.
 * Returns true if a plan-selection modal is visible.
 */
async function isSubscriptionGated(page: import('@playwright/test').Page): Promise<boolean> {
  const gateModal = page.getByText(/Vælg en plan|Funktionen kræver|Velkommen til BizzAssist/i);
  return gateModal.isVisible({ timeout: 3_000 }).catch(() => false);
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. ANALYSE LANDING PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — landing page', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse');
  });

  test('landing page renders with heading', async ({ page }) => {
    const heading = page.getByRole('heading', { name: /Analyse/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });

  test('AI Analyse and Data Analyse cards are visible', async ({ page }) => {
    const aiCard = page.locator('a[href="/dashboard/analyse/ai"]').first();
    await expect(aiCard).toBeVisible({ timeout: 15_000 });

    const dataCard = page.locator('a[href="/dashboard/analyse/data"]').first();
    await expect(dataCard).toBeVisible({ timeout: 10_000 });
  });

  test('branch module cards render in the grid', async ({ page }) => {
    // All cards are in a flat grid — check for known module cards by href
    const annonceCard = page.locator('a[href="/dashboard/analyse/annonce"]').first();
    await expect(annonceCard).toBeVisible({ timeout: 15_000 });

    const forsikringCard = page.locator('a[href="/dashboard/analyse/forsikring"]').first();
    await expect(forsikringCard).toBeVisible({ timeout: 5_000 });

    const kreditCard = page.locator('a[href="/dashboard/analyse/kreditvurdering"]').first();
    await expect(kreditCard).toBeVisible({ timeout: 5_000 });
  });

  test('clicking a module card navigates to that module', async ({ page }) => {
    const kreditCard = page.locator('a[href="/dashboard/analyse/kreditvurdering"]').first();
    await expect(kreditCard).toBeVisible({ timeout: 15_000 });
    await kreditCard.click();
    await expect(page).toHaveURL(/\/dashboard\/analyse\/kreditvurdering/, { timeout: 15_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. KREDITVURDERING (Standard AnalyseModulLayout)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — Kreditvurdering', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/kreditvurdering');
  });

  test('module page loads with heading and autocomplete search field', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Kreditvurdering is subscription-gated for test user');
      return;
    }
    const heading = page.getByRole('heading', { name: /Kreditvurdering/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });

    // New: autocomplete search field should be present
    const searchInput = page.getByPlaceholder(/Søg efter adresse, virksomhed eller person/i);
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
  });

  test('autocomplete search shows results when typing a company name', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }

    // Dismiss cookie banner if present (can block autocomplete dropdown)
    const cookieAccept = page.getByRole('button', { name: /Acceptér alle|Accepter/i });
    if (await cookieAccept.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cookieAccept.click();
    }

    const searchInput = page.getByPlaceholder(/Søg efter adresse, virksomhed eller person/i);
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    // Type a known company name character by character to trigger debounced autocomplete
    await searchInput.click();
    await searchInput.pressSequentially('Danske Bank', { delay: 50 });

    // Autocomplete dropdown should appear with results (300ms debounce + API call)
    const dropdownResult = page
      .locator('button')
      .filter({ hasText: /Danske Bank|DANSKE BANK/i })
      .first();
    await expect(dropdownResult).toBeVisible({ timeout: 15_000 });

    // Click the result — should populate target fields
    await dropdownResult.click();

    // Kør analyse button should now be enabled (target ID is set)
    const runBtn = page.getByRole('button', { name: /Kør analyse/i });
    await expect(runBtn).toBeEnabled({ timeout: 5_000 });
  });

  test('manual input fallback: target type selector toggles placeholder', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    // "eller angiv manuelt:" section should be visible
    const manualLabel = page.getByText(/eller angiv manuelt/i);
    await expect(manualLabel).toBeVisible({ timeout: 10_000 });

    // Default is Virksomhed → CVR placeholder
    const cvrInput = page.getByPlaceholder(/CVR-nummer/i);
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });

    // Click Ejendom → BFE placeholder
    await page.getByRole('button', { name: 'Ejendom' }).click();
    const bfeInput = page.getByPlaceholder(/BFE-nummer/i);
    await expect(bfeInput).toBeVisible({ timeout: 5_000 });

    // Click Person → EnhedsNummer placeholder
    await page.getByRole('button', { name: 'Person' }).click();
    const personInput = page.getByPlaceholder('EnhedsNummer');
    await expect(personInput).toBeVisible({ timeout: 5_000 });
  });

  test('enter CVR manually and click Kør analyse → AI chat opens with streaming', async ({
    page,
  }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const cvrInput = page.getByPlaceholder(/CVR-nummer/i);
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    await cvrInput.fill('10150817');

    await page.getByRole('button', { name: /Kør analyse/i }).click();

    const chatDrawer = page
      .locator('button[aria-label="Luk chat"], button[aria-label="Close chat"]')
      .first();
    await expect(chatDrawer).toBeVisible({ timeout: 15_000 });

    const aiResponse = page
      .locator('.prose, [class*="markdown"], [class*="whitespace-pre"]')
      .first();
    await expect(aiResponse).toBeVisible({ timeout: 60_000 });
  });

  test('autocomplete search → select result → Kør analyse → AI chat streams', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }

    // Dismiss cookie banner if present
    const cookieAccept = page.getByRole('button', { name: /Acceptér alle|Accepter/i });
    if (await cookieAccept.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cookieAccept.click();
    }

    const searchInput = page.getByPlaceholder(/Søg efter adresse, virksomhed eller person/i);
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    await searchInput.click();
    await searchInput.pressSequentially('COOP Danmark', { delay: 50 });

    const dropdownResult = page.locator('button').filter({ hasText: /COOP/i }).first();
    await expect(dropdownResult).toBeVisible({ timeout: 15_000 });
    await dropdownResult.click();

    // Run analysis
    await page.getByRole('button', { name: /Kør analyse/i }).click();

    const chatDrawer = page
      .locator('button[aria-label="Luk chat"], button[aria-label="Close chat"]')
      .first();
    await expect(chatDrawer).toBeVisible({ timeout: 15_000 });

    const aiResponse = page
      .locator('.prose, [class*="markdown"], [class*="whitespace-pre"]')
      .first();
    await expect(aiResponse).toBeVisible({ timeout: 60_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. DUE DILIGENCE (Standard AnalyseModulLayout)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — Due Diligence', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/due-diligence');
  });

  test('module page loads with heading', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const heading = page.getByRole('heading', { name: /Due Diligence/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });

  test('data-kilder section shows tool tags', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const toolsSection = page.getByText('Data-kilder brugt i denne analyse:');
    await expect(toolsSection).toBeVisible({ timeout: 10_000 });
  });

  test('enter CVR and click Kør analyse → AI chat opens', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const cvrInput = page.getByPlaceholder('CVR-nummer (8 cifre)');
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    await cvrInput.fill('25313763');

    await page.getByRole('button', { name: /Kør analyse/i }).click();

    const chatClose = page
      .locator('button[aria-label="Luk chat"], button[aria-label="Close chat"]')
      .first();
    await expect(chatClose).toBeVisible({ timeout: 15_000 });

    const aiContent = page
      .locator('.prose, [class*="markdown"], [class*="whitespace-pre"]')
      .first();
    await expect(aiContent).toBeVisible({ timeout: 60_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. AML/KYC (Standard AnalyseModulLayout)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — AML/KYC', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/aml-kyc');
  });

  test('module page loads with AML/KYC heading', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const heading = page.getByRole('heading', { name: /AML\/KYC/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });

  test('default target is Virksomhed with CVR input', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const cvrInput = page.getByPlaceholder('CVR-nummer (8 cifre)');
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    const nameInput = page.getByPlaceholder('Navn (valgfrit)');
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
  });

  test('enter CVR and run analyse → AI chat streams result', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const cvrInput = page.getByPlaceholder('CVR-nummer (8 cifre)');
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    await cvrInput.fill('10150817');
    await page.getByPlaceholder('Navn (valgfrit)').fill('COOP Danmark');

    await page.getByRole('button', { name: /Kør analyse/i }).click();

    const chatClose = page
      .locator('button[aria-label="Luk chat"], button[aria-label="Close chat"]')
      .first();
    await expect(chatClose).toBeVisible({ timeout: 15_000 });

    const aiContent = page
      .locator('.prose, [class*="markdown"], [class*="whitespace-pre"]')
      .first();
    await expect(aiContent).toBeVisible({ timeout: 60_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. EJENDOMSINVESTOR (Standard AnalyseModulLayout)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — Ejendomsinvestor', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/ejendomsinvestor');
  });

  test('module page loads with heading or subscription gate', async ({ page }) => {
    const gated = await isSubscriptionGated(page);
    if (gated) {
      // Verify the subscription gate renders properly
      const gateText = page.getByText(/Vælg en plan|Funktionen kræver|Velkommen/i).first();
      await expect(gateText).toBeVisible({ timeout: 5_000 });
      return;
    }
    const heading = page.getByRole('heading', { name: /Ejendomsinvestor/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });

  test('switch to Ejendom target and enter BFE', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    await page.getByRole('button', { name: 'Ejendom' }).click();
    const bfeInput = page.getByPlaceholder('BFE-nummer');
    await expect(bfeInput).toBeVisible({ timeout: 5_000 });
    await bfeInput.fill('5764389');
    const runBtn = page.getByRole('button', { name: /Kør analyse/i });
    await expect(runBtn).toBeEnabled({ timeout: 3_000 });
  });

  test('enter CVR and run analyse → AI chat opens and streams', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const cvrInput = page.getByPlaceholder('CVR-nummer (8 cifre)');
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    await cvrInput.fill('25313763');

    await page.getByRole('button', { name: /Kør analyse/i }).click();

    const chatClose = page
      .locator('button[aria-label="Luk chat"], button[aria-label="Close chat"]')
      .first();
    await expect(chatClose).toBeVisible({ timeout: 15_000 });

    const aiContent = page
      .locator('.prose, [class*="markdown"], [class*="whitespace-pre"]')
      .first();
    await expect(aiContent).toBeVisible({ timeout: 60_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. REVISOR-BENCHMARK (Standard AnalyseModulLayout)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — Revisor-benchmark', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/revisor-benchmark');
  });

  test('module page loads with heading or subscription gate', async ({ page }) => {
    const gated = await isSubscriptionGated(page);
    if (gated) {
      const gateText = page.getByText(/Vælg en plan|Funktionen kræver|Velkommen/i).first();
      await expect(gateText).toBeVisible({ timeout: 5_000 });
      return;
    }
    const heading = page.getByRole('heading', { name: /Revisor/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });

  test('target type buttons are present and interactive', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const personBtn = page.getByRole('button', { name: 'Person' });
    const virksomhedBtn = page.getByRole('button', { name: 'Virksomhed' });
    const ejendomBtn = page.getByRole('button', { name: 'Ejendom' });

    await expect(personBtn).toBeVisible({ timeout: 10_000 });
    await expect(virksomhedBtn).toBeVisible({ timeout: 5_000 });
    await expect(ejendomBtn).toBeVisible({ timeout: 5_000 });
  });

  test('enter CVR and run analyse → AI chat streams result', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const cvrInput = page.getByPlaceholder('CVR-nummer (8 cifre)');
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    await cvrInput.fill('10150817');

    await page.getByRole('button', { name: /Kør analyse/i }).click();

    const chatClose = page
      .locator('button[aria-label="Luk chat"], button[aria-label="Close chat"]')
      .first();
    await expect(chatClose).toBeVisible({ timeout: 15_000 });

    const aiContent = page
      .locator('.prose, [class*="markdown"], [class*="whitespace-pre"]')
      .first();
    await expect(aiContent).toBeVisible({ timeout: 60_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. INKASSO-AKTIVSØGNING (Standard AnalyseModulLayout)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — Inkasso aktivsøgning', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/inkasso-aktivsoegning');
  });

  test('module page loads with Inkasso heading', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const heading = page.getByRole('heading', { name: /Inkasso/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });

  test('switch to Person target and enter EnhedsNummer', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    await page.getByRole('button', { name: 'Person' }).click();
    const personInput = page.getByPlaceholder('EnhedsNummer');
    await expect(personInput).toBeVisible({ timeout: 5_000 });
    await personInput.fill('4000115446');

    const runBtn = page.getByRole('button', { name: /Kør analyse/i });
    await expect(runBtn).toBeEnabled({ timeout: 3_000 });
  });

  test('enter CVR and run analyse → AI chat opens', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const cvrInput = page.getByPlaceholder('CVR-nummer (8 cifre)');
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    await cvrInput.fill('10150817');

    await page.getByRole('button', { name: /Kør analyse/i }).click();

    const chatClose = page
      .locator('button[aria-label="Luk chat"], button[aria-label="Close chat"]')
      .first();
    await expect(chatClose).toBeVisible({ timeout: 15_000 });

    const aiContent = page
      .locator('.prose, [class*="markdown"], [class*="whitespace-pre"]')
      .first();
    await expect(aiContent).toBeVisible({ timeout: 60_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. KOMMUNE-ENERGI (Standard AnalyseModulLayout)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — Kommune energi', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/kommune-energi');
  });

  test('module page loads with Kommune energi heading', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const heading = page.getByRole('heading', { name: /Kommune energi/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });

  test('Ejendom target accepts BFE-nummer', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    await page.getByRole('button', { name: 'Ejendom' }).click();
    const bfeInput = page.getByPlaceholder('BFE-nummer');
    await expect(bfeInput).toBeVisible({ timeout: 5_000 });
    await bfeInput.fill('5764389');
    const runBtn = page.getByRole('button', { name: /Kør analyse/i });
    await expect(runBtn).toBeEnabled({ timeout: 3_000 });
  });

  test('enter CVR and run analyse → AI chat streams', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const cvrInput = page.getByPlaceholder('CVR-nummer (8 cifre)');
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    await cvrInput.fill('25313763');

    await page.getByRole('button', { name: /Kør analyse/i }).click();

    const chatClose = page
      .locator('button[aria-label="Luk chat"], button[aria-label="Close chat"]')
      .first();
    await expect(chatClose).toBeVisible({ timeout: 15_000 });

    const aiContent = page
      .locator('.prose, [class*="markdown"], [class*="whitespace-pre"]')
      .first();
    await expect(aiContent).toBeVisible({ timeout: 60_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. BOLIGANNONCE (Custom UI)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — Boligannonce', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/annonce');
  });

  test('annonce page loads with heading and tone selector', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const heading = page.getByRole('heading', { name: /Boligannonce/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });

    const toneLabel = page.getByText('Annonce-tone:');
    await expect(toneLabel).toBeVisible({ timeout: 10_000 });
  });

  test('BFE input and tone options are present', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const bfeInput = page.getByPlaceholder('BFE-nummer (fx 2081243)');
    await expect(bfeInput).toBeVisible({ timeout: 10_000 });

    const luksusBtn = page.getByRole('button', { name: /Luksus/i });
    const familieBtn = page.getByRole('button', { name: /Familievenlig/i });
    const investorBtn = page.getByRole('button', { name: /Investor/i });
    await expect(luksusBtn).toBeVisible({ timeout: 5_000 });
    await expect(familieBtn).toBeVisible({ timeout: 5_000 });
    await expect(investorBtn).toBeVisible({ timeout: 5_000 });
  });

  test('enter BFE, select tone, generate → AI chat opens with streaming', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const bfeInput = page.getByPlaceholder('BFE-nummer (fx 2081243)');
    await expect(bfeInput).toBeVisible({ timeout: 10_000 });
    await bfeInput.fill('5764389');

    await page.getByRole('button', { name: /Investor/i }).click();

    await page.getByRole('button', { name: /Generér annonce/i }).click();

    const chatClose = page
      .locator('button[aria-label="Luk chat"], button[aria-label="Close chat"]')
      .first();
    await expect(chatClose).toBeVisible({ timeout: 15_000 });

    const aiContent = page
      .locator('.prose, [class*="markdown"], [class*="whitespace-pre"]')
      .first();
    await expect(aiContent).toBeVisible({ timeout: 60_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. FORSIKRING-GAP (3-Step Wizard)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — Forsikring gap', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/forsikring');
  });

  test('forsikring page loads with step 1 visible', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const heading = page.getByRole('heading', { name: /Forsikring/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });

    const personBtn = page.getByRole('button', { name: 'Person' });
    const virksomhedBtn = page.getByRole('button', { name: 'Virksomhed' });
    await expect(personBtn).toBeVisible({ timeout: 10_000 });
    await expect(virksomhedBtn).toBeVisible({ timeout: 5_000 });
  });

  test('enter CVR and click Næste → step 2 with file upload appears', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const virksomhedBtn = page.getByRole('button', { name: 'Virksomhed' });
    await expect(virksomhedBtn).toBeVisible({ timeout: 10_000 });
    await virksomhedBtn.click();

    const cvrInput = page.getByPlaceholder(/CVR-nummer/i);
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    await cvrInput.fill('10150817');

    await page.getByRole('button', { name: /Næste/i }).click();

    const uploadArea = page.locator('[class*="border-dashed"]').first();
    await expect(uploadArea).toBeVisible({ timeout: 10_000 });
  });

  test('step 2 back button returns to step 1', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    const virksomhedBtn = page.getByRole('button', { name: 'Virksomhed' });
    await expect(virksomhedBtn).toBeVisible({ timeout: 10_000 });
    await virksomhedBtn.click();

    const cvrInput = page.getByPlaceholder(/CVR-nummer/i);
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
    await cvrInput.fill('10150817');
    await page.getByRole('button', { name: /Næste/i }).click();

    const uploadArea = page.locator('[class*="border-dashed"]').first();
    await expect(uploadArea).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Tilbage/i }).click();

    await expect(page.getByPlaceholder(/CVR-nummer/i)).toBeVisible({ timeout: 10_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   11. AI ANALYSE (/dashboard/analyse/ai)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — AI Analyse', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/ai');
  });

  test('AI analyse page loads with analysis area cards', async ({ page }) => {
    // Should show "VÆLG ANALYSEOMRÅDE" heading and Virksomhedsanalyse card
    const sectionHeading = page.getByText(/VÆLG ANALYSEOMRÅDE/i);
    await expect(sectionHeading).toBeVisible({ timeout: 15_000 });

    const virksomhedCard = page.getByText(/Virksomhedsanalyse/i).first();
    await expect(virksomhedCard).toBeVisible({ timeout: 10_000 });
  });

  test('selecting Virksomhedsanalyse shows target input form', async ({ page }) => {
    // Click the Virksomhedsanalyse card
    const virksomhedCard = page.getByText('Virksomhedsanalyse').first();
    await expect(virksomhedCard).toBeVisible({ timeout: 15_000 });
    await virksomhedCard.click();

    // Should show HVAD VIL DU ANALYSERE? section with target input
    const sectionLabel = page.getByText(/HVAD VIL DU ANALYSERE/i);
    await expect(sectionLabel).toBeVisible({ timeout: 10_000 });

    // Target input — scoped to main content (not the global search bar)
    const targetInput = page
      .getByPlaceholder(/CVR-nummer.*BFE-nummer|BFE-nummer.*adresse/i)
      .first();
    await expect(targetInput).toBeVisible({ timeout: 10_000 });
  });

  test('run Virksomhedsanalyse with real CVR → streaming result appears', async ({ page }) => {
    // Click Virksomhedsanalyse card
    const virksomhedCard = page.getByText('Virksomhedsanalyse').first();
    await expect(virksomhedCard).toBeVisible({ timeout: 15_000 });
    await virksomhedCard.click();

    // Wait for form to appear
    const sectionLabel = page.getByText(/HVAD VIL DU ANALYSERE/i);
    await expect(sectionLabel).toBeVisible({ timeout: 10_000 });

    // Fill target — use the specific analyse-input placeholder (not global search)
    const targetInput = page
      .getByPlaceholder(/CVR-nummer.*BFE-nummer|BFE-nummer.*adresse/i)
      .first();
    await expect(targetInput).toBeVisible({ timeout: 10_000 });
    await targetInput.fill('10150817');

    // Click Kør analyse / Run analysis — button text includes the analysis type
    const runBtn = page.getByRole('button', { name: /Kør analyse/i }).first();
    await expect(runBtn).toBeEnabled({ timeout: 5_000 });
    await runBtn.click();

    // Streaming result should appear
    const resultSection = page
      .getByText(/Analyseresultat|Analysis result/i)
      .or(page.locator('.prose, [class*="whitespace-pre"]'))
      .first();
    await expect(resultSection).toBeVisible({ timeout: 60_000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   12. DATA ANALYSE (/dashboard/analyse/data)
   ═══════════════════════════════════════════════════════════════════════════ */
test.describe('Analyse — Data Analyse (Query Builder)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAnalyseModule(page, '/dashboard/analyse/data');
  });

  test('data analyse page loads with query input', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    // Heading
    const heading = page.getByText(/AI Query Builder/i).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });

    // Query input — use the specific placeholder to avoid matching global search
    const queryInput = page
      .getByPlaceholder(/Gennemsnitligt boligareal|Energimærke fordeling/i)
      .first();
    await expect(queryInput).toBeVisible({ timeout: 10_000 });
  });

  test('suggested query buttons are visible and clickable', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    // Wait for heading first to confirm page loaded
    await expect(page.getByText(/AI Query Builder/i).first()).toBeVisible({ timeout: 15_000 });

    // Find suggested query buttons (they contain known query text)
    const suggested = page.getByText(/Hvor mange ejendomme per kommune/i).first();
    await expect(suggested).toBeVisible({ timeout: 10_000 });
    await suggested.click();

    // Should start loading — look for spinner
    const loadingIndicator = page
      .locator('[class*="animate-spin"]')
      .or(page.getByText(/Genererer|Analyserer|Kører/i))
      .first();
    await expect(loadingIndicator).toBeVisible({ timeout: 15_000 });

    // Wait for results — table should appear
    const resultTable = page.locator('table').first();
    await expect(resultTable).toBeVisible({ timeout: 60_000 });
  });

  test('submit custom query → results with data table', async ({ page }) => {
    if (await isSubscriptionGated(page)) {
      test.skip(true, 'Subscription-gated');
      return;
    }
    await expect(page.getByText(/AI Query Builder/i).first()).toBeVisible({ timeout: 15_000 });

    // Fill query input — use the specific placeholder
    const queryInput = page
      .getByPlaceholder(/Gennemsnitligt boligareal|Energimærke fordeling/i)
      .first();
    await expect(queryInput).toBeVisible({ timeout: 10_000 });
    await queryInput.fill('Top 20 kommuner efter antal ejendomme');

    // Submit via form (click the Analysér button) — use force to bypass disabled check
    // (button becomes enabled when input has text)
    const submitBtn = page.getByRole('button', { name: /Analysér/i }).first();
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await submitBtn.click();

    // Wait for results table
    const resultTable = page.locator('table').first();
    await expect(resultTable).toBeVisible({ timeout: 60_000 });

    // Verify data rows exist
    const dataRows = resultTable.locator('tbody tr');
    const rowCount = await dataRows.count();
    expect(rowCount).toBeGreaterThan(0);
  });
});
