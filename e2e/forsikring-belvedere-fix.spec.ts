/**
 * BIZZ-1592 — End-to-end verifikation af fix for "0 forsikrede" bug.
 *
 * Verificerer at:
 *   1. POST /api/forsikring/analyser med stale scopeDocIds returnerer
 *      insured_count > 0 (fallback til alle policer aktiveret)
 *   2. POST /api/forsikring/analyser UDEN scopeDocIds også returnerer
 *      korrekt insured_count > 0
 *   3. Forsikring-siden renderer uden console-fejl
 *
 * Test bruger Belvedere CVR 24301117 som har 17 aktiver og 5 policer
 * i preview-DB (alle med property_address men uden CVR/sum/BFE).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const BELVEDERE_CVR = '24301117';
const BELVEDERE_NAVN = 'BELVEDERE EJENDOMME A/S';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping belvedere verification');
  }
});

test.describe('BIZZ-1592 Belvedere forsikring fix verification', () => {
  test('analyser UDEN scopeDocIds → insured_count > 0', async ({ page }) => {
    const res = await page.request.post('/api/forsikring/analyser', {
      data: {
        kunde_type: 'virksomhed',
        kunde_id: BELVEDERE_CVR,
        kunde_navn: BELVEDERE_NAVN,
      },
    });
    expect(res.status()).toBe(200);
    const data = (await res.json()) as {
      total_aktiver?: number;
      insured_count?: number;
    };

    console.log(`[BIZZ-1592] no-scope: total=${data.total_aktiver}, insured=${data.insured_count}`);
    expect(data.total_aktiver).toBeGreaterThan(0);
    expect(data.insured_count).toBeGreaterThan(0);
  });

  test('analyser MED stale scopeDocIds → fallback giver insured_count > 0', async ({ page }) => {
    // Send 9 phantom doc IDs (UUIDs der ikke findes i DB).
    // Uden fallback ville scopeDocIds filtrere ALLE policer væk → 0 insured.
    // Med fallback bruges alle policer → 8 insured.
    const stalIds = Array.from(
      { length: 9 },
      (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
    );
    const res = await page.request.post('/api/forsikring/analyser', {
      data: {
        kunde_type: 'virksomhed',
        kunde_id: BELVEDERE_CVR,
        kunde_navn: BELVEDERE_NAVN,
        document_ids: stalIds,
      },
    });
    expect(res.status()).toBe(200);
    const data = (await res.json()) as {
      total_aktiver?: number;
      insured_count?: number;
    };

    console.log(
      `[BIZZ-1592] stale-scope: total=${data.total_aktiver}, insured=${data.insured_count}`
    );
    expect(data.total_aktiver).toBeGreaterThan(0);
    // KRITISK: fallback skal aktivere — insured > 0
    expect(data.insured_count).toBeGreaterThan(0);
  });

  test('Forsikring-siden renderer uden critical console-fejl', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.goto('/dashboard/forsikring');
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    // Acceptable hvis nogle 3rd-party-fejl, men ingen 'TypeError' eller 'undefined'
    const critical = consoleErrors.filter((e) => /TypeError|Cannot read|undefined is not/i.test(e));
    expect(critical, `Critical errors: ${critical.join(' | ')}`).toEqual([]);
  });
});
