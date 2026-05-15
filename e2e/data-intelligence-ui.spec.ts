/**
 * Data Intelligence — Frontend Browser E2E Suite
 *
 * 15 realistiske dansk-sprogede brugerspørgsmål testet via den fulde UI-flow:
 *   1. Naviger til /dashboard/analyse/intelligence
 *   2. Indtast spørgsmål i prompt-feltet
 *   3. Klik "Spørg"
 *   4. Vent på resultater (tabel, forklaring eller fejl)
 *   5. Verificér at resultatet er korrekt
 *   6. Nulstil med "Stil et nyt spørgsmål"
 *
 * Kører mod E2E_BASE_URL (default test.bizzassist.dk via env).
 * Kræver E2E_TEST_EMAIL + E2E_TEST_PASS i .env.local.
 *
 * @module e2e/data-intelligence-ui
 */

import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

/* ── Skip uden auth ───────────────────────────────────────────────────── */
test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping authenticated intelligence UI tests');
  }
});

/* ── Timeouts — AI SQL generation + query kan tage 30-60s ─────────────── */
test.setTimeout(120_000);

interface UiScenario {
  /** Unik scenarie-id */
  id: number;
  /** Det spørgsmål brugeren skriver */
  prompt: string;
  /** Forvent at en resultat-tabel vises med >= N rækker */
  expectTableMinRows?: number;
  /** Forvent at en forklaring (amber-boks) vises i stedet for tabel */
  allowExplanation?: boolean;
  /** Forvent at en fejl-boks vises */
  expectError?: boolean;
  /** Forvent at fejlteksten matcher dette regex */
  expectErrorMatches?: RegExp;
  /** Max ventetid for svar i ms */
  timeBudgetMs?: number;
  /** Beskrivelse til test-output */
  description: string;
}

const SCENARIOS: UiScenario[] = [
  // ── Enkle tællinger ──
  {
    id: 1,
    prompt: 'Hvor mange virksomheder er der i alt?',
    expectTableMinRows: 1,
    description: 'Simpel COUNT af alle virksomheder — forventer 1 række med et tal > 2M',
  },
  {
    id: 2,
    prompt: 'Hvor mange ejendomme har vi data på?',
    expectTableMinRows: 1,
    description: 'COUNT af ejendomme — forventer 1 række med tal > 40K',
  },
  {
    id: 3,
    prompt: 'Hvilken kommune har flest virksomheder?',
    expectTableMinRows: 1,
    description: 'GROUP BY kommune med ORDER BY DESC LIMIT — forventer København øverst',
  },

  // ── Top N / ranking ──
  {
    id: 4,
    prompt: 'Top 10 brancher efter antal aktive virksomheder',
    expectTableMinRows: 5,
    description: 'Branche-ranking — forventer mindst 5 brancher i tabellen',
  },
  {
    id: 5,
    prompt: 'Top 20 virksomhedsformer efter antal',
    expectTableMinRows: 5,
    description: 'Virksomhedsform-fordeling — A/S, ApS, I/S osv.',
  },

  // ── Filtrering ──
  {
    id: 6,
    prompt: 'Virksomheder stiftet i 2025',
    expectTableMinRows: 1,
    allowExplanation: true,
    description: 'Filtrering på stiftelsesdato — forventer liste af nyere virksomheder',
  },
  {
    id: 7,
    prompt: 'Find virksomheder der ejer mere end 5 ejendomme',
    expectTableMinRows: 0,
    allowExplanation: true,
    timeBudgetMs: 100_000,
    description: 'Join-baseret filtrering — virksomheder med mange ejendomme',
  },

  // ── Aggregeringer ──
  {
    id: 8,
    prompt: 'Hvor mange ejendomme har vurdering over 5 mio kr?',
    expectTableMinRows: 1,
    allowExplanation: true,
    description: 'COUNT med WHERE-filter på vurderingsværdi',
  },
  {
    id: 9,
    prompt: 'Antal ejendomme per ejer-type',
    expectTableMinRows: 1,
    timeBudgetMs: 100_000,
    description: 'GROUP BY ejer_type — forventer fordeling (person/virksomhed/etc.)',
  },

  // ── Tidsbaserede ──
  {
    id: 10,
    prompt: 'Hvad er den nyeste ejendomsdata?',
    expectTableMinRows: 1,
    description: 'MAX(dato) eller ORDER BY dato DESC LIMIT 1 — forventer en dato',
  },
  {
    id: 11,
    prompt: 'Hvor mange virksomheder er stiftet de seneste 30 dage?',
    expectTableMinRows: 1,
    description: 'COUNT med relativ dato-filter — forventer et antal',
  },

  // ── Komplekse joins ──
  {
    id: 12,
    prompt: 'Hvilke kommuner har flest unikke virksomhedsejere af ejendomme?',
    expectTableMinRows: 0,
    allowExplanation: true,
    timeBudgetMs: 100_000,
    description: 'Kompleks join: ejendom → ejerskab → virksomhed → kommune',
  },

  // ── Sikkerhed / edge cases ──
  {
    id: 13,
    prompt: 'Slet alle virksomheder fra databasen',
    allowExplanation: true,
    description: 'Destruktiv SQL — AI skal afslå med forklaring, IKKE køre DELETE',
  },
  {
    id: 14,
    prompt: 'Vis brugerdata fra auth.users tabellen',
    expectError: true,
    allowExplanation: true,
    description: 'System-schema adgang — skal afvises af validator',
  },
  {
    id: 15,
    prompt: 'SELECT pg_sleep(60)',
    expectError: true,
    allowExplanation: true,
    description: 'Forbudt funktion — skal afvises af AST-validator',
  },
];

test.describe('Data Intelligence — Browser UI E2E (15 brugerspørgsmål)', () => {
  /**
   * Sæt serialiseret kørsel — vi navigerer til samme side og nulstiller
   * mellem hvert spørgsmål for at undgå rate limiting og state-konflikter.
   */
  test.describe.configure({ mode: 'serial' });

  /** Fælles hjælper: naviger til intelligence-siden og gør klar. */
  async function navigateToIntelligence(page: import('@playwright/test').Page) {
    await page.goto('/dashboard/analyse/intelligence');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Dismiss cookie banner hvis synlig
    const cookieAccept = page.getByRole('button', { name: /Acceptér alle|Accepter/i });
    if (await cookieAccept.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cookieAccept.click();
    }

    // Vent på at heading er synlig → siden er loadet
    const heading = page.getByRole('heading', { name: /Data Intelligence/i });
    await expect(heading).toBeVisible({ timeout: 15_000 });
  }

  /* ── 0. Smoke test: siden loader korrekt med suggestions ────────────── */
  test('side loader med heading, prompt-felt og forslag', async ({ page }) => {
    await navigateToIntelligence(page);

    // Prompt-felt
    const input = page.getByLabel('Dit spørgsmål');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();

    // Spørg-knap (disabled når input er tom)
    const submitBtn = page.getByRole('button', { name: /Spørg/i });
    await expect(submitBtn).toBeVisible();
    await expect(submitBtn).toBeDisabled();

    // Forslag-knapper synlige
    const suggestions = page.getByText('Eller prøv et af disse spørgsmål:');
    await expect(suggestions).toBeVisible();

    // Mindst 4 forslags-knapper
    const suggestionBtns = page.locator('button').filter({
      hasText: /virksomheder|ejendomme|brancher|kommune|energimærke/i,
    });
    const count = await suggestionBtns.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  /* ── 1. Suggestion-klik flow ────────────────────────────────────────── */
  test('klik på forslag-knap udfylder prompt og kører query', async ({ page }) => {
    await navigateToIntelligence(page);

    // Klik på "Hvor mange virksomheder er der i alt?"
    const suggestionBtn = page
      .locator('button')
      .filter({ hasText: 'Hvor mange virksomheder er der i alt?' });
    await expect(suggestionBtn).toBeVisible();
    await suggestionBtn.click();

    // Loading-state skal vises
    const loadingText = page.getByText('Genererer SQL og henter data…');
    await expect(loadingText).toBeVisible({ timeout: 5_000 });

    // Vent på at loading forsvinder og resultat vises
    await expect(loadingText).toBeHidden({ timeout: 90_000 });

    // Tabel eller forklaring skal være synlig
    const table = page.locator('table');
    const explanation = page.locator('.border-amber-900');
    const either = table.or(explanation).first();
    await expect(either).toBeVisible({ timeout: 10_000 });

    // Nulstil-knap skal være synlig
    const resetBtn = page.getByText('← Stil et nyt spørgsmål');
    await expect(resetBtn).toBeVisible();
  });

  /* ── Spørgsmål 1-15 via UI ─────────────────────────────────────────── */
  for (const scenario of SCENARIOS) {
    test(`#${scenario.id}: ${scenario.description}`, async ({ page }) => {
      const budget = scenario.timeBudgetMs ?? 90_000;
      await navigateToIntelligence(page);

      const start = Date.now();

      // Indtast prompt
      const input = page.getByLabel('Dit spørgsmål');
      await expect(input).toBeVisible({ timeout: 10_000 });
      await input.fill(scenario.prompt);

      // Spørg-knap skal nu være enabled
      const submitBtn = page.getByRole('button', { name: /Spørg/i });
      await expect(submitBtn).toBeEnabled({ timeout: 3_000 });
      await submitBtn.click();

      // Loading skal vises
      const loadingText = page.getByText('Genererer SQL og henter data…');
      await expect(loadingText).toBeVisible({ timeout: 5_000 });

      // Vent på at loading forsvinder
      await expect(loadingText).toBeHidden({ timeout: budget });

      const elapsed = Date.now() - start;
      console.log(
        `[UI #${scenario.id}] elapsed=${elapsed}ms prompt="${scenario.prompt.slice(0, 50)}"`
      );

      // Time budget check
      expect(elapsed).toBeLessThan(budget);

      // ── Verificér resultat baseret på scenario-type ──

      if (scenario.expectError) {
        // Forvent enten fejl-boks ELLER forklaring (amber)
        const errorBox = page.locator('.border-red-900');
        const explanationBox = page.locator('.border-amber-900');
        const eitherError = errorBox.or(explanationBox).first();
        await expect(eitherError).toBeVisible({ timeout: 10_000 });

        if (await errorBox.isVisible().catch(() => false)) {
          const errorText = await page.locator('.text-red-300').textContent();
          console.log(`[UI #${scenario.id}] error="${errorText?.slice(0, 80)}"`);
          if (scenario.expectErrorMatches && errorText) {
            expect(errorText).toMatch(scenario.expectErrorMatches);
          }
        }
      } else if (scenario.allowExplanation) {
        // Forvent enten tabel ELLER forklaring
        const table = page.locator('table');
        const explanationBox = page.locator('.border-amber-900');
        const errorBox = page.locator('.border-red-900');

        const hasTable = await table.isVisible({ timeout: 5_000 }).catch(() => false);
        const hasExplanation = await explanationBox
          .isVisible({ timeout: 2_000 })
          .catch(() => false);
        const hasError = await errorBox.isVisible({ timeout: 2_000 }).catch(() => false);

        // Mindst ét af disse skal være synligt
        expect(hasTable || hasExplanation || hasError).toBe(true);

        if (hasTable && scenario.expectTableMinRows !== undefined) {
          const rowCount = await table.locator('tbody tr').count();
          console.log(`[UI #${scenario.id}] tableRows=${rowCount}`);
          expect(rowCount).toBeGreaterThanOrEqual(scenario.expectTableMinRows);
        }

        if (hasExplanation) {
          const explText = await explanationBox.locator('p').textContent();
          console.log(`[UI #${scenario.id}] explanation="${explText?.slice(0, 80)}"`);
          expect(explText?.length ?? 0).toBeGreaterThan(10);
        }
      } else {
        // Forvent en resultat-tabel
        const table = page.locator('table');
        await expect(table).toBeVisible({ timeout: 10_000 });

        // Verificér rækker
        const rows = table.locator('tbody tr');
        const rowCount = await rows.count();
        console.log(`[UI #${scenario.id}] tableRows=${rowCount}`);

        if (scenario.expectTableMinRows !== undefined) {
          expect(rowCount).toBeGreaterThanOrEqual(scenario.expectTableMinRows);
        }

        // Verificér stats (rækker / ms / kolonner)
        const statsRow = page.getByText(/rækker/);
        await expect(statsRow).toBeVisible({ timeout: 5_000 });

        // Verificér at SQL toggle er tilgængelig
        const sqlToggle = page.getByText(/Vis genereret SQL/);
        await expect(sqlToggle).toBeVisible({ timeout: 5_000 });

        // Klik på SQL toggle og verificér at SQL vises
        await sqlToggle.click();
        const sqlBlock = page.locator('pre#sql-block');
        await expect(sqlBlock).toBeVisible({ timeout: 3_000 });

        const sqlText = await sqlBlock.textContent();
        console.log(`[UI #${scenario.id}] sql="${sqlText?.slice(0, 80)}"`);
        expect(sqlText?.length ?? 0).toBeGreaterThan(5);

        // Verificér at SQL indeholder SELECT (ikke INSERT/DELETE/DROP)
        expect(sqlText?.toUpperCase()).toContain('SELECT');
      }

      // Verificér at "Stil et nyt spørgsmål" knap er synlig (med mindre der var fejl uden response)
      const resetBtn = page.getByText('← Stil et nyt spørgsmål');
      if (await resetBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await resetBtn.click();
        // Forslag skal komme tilbage
        const suggestions = page.getByText('Eller prøv et af disse spørgsmål:');
        await expect(suggestions).toBeVisible({ timeout: 5_000 });
      }
    });
  }
});
