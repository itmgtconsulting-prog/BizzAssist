/**
 * E2E regression for the AI hent_bbr_batch tool — BIZZ-2291.
 *
 * For a multi-address BBR request the assistant should call hent_bbr_batch ONCE
 * (geocode + BBR for all in a single tool round) instead of hent_bbr_data per
 * address — this is what lets large batches finish within the round/time budget.
 * The test asserts the batch tool actually fires (deterministic status event).
 * (Real multi-property output is verified live and documented in the ticket.)
 *
 * Auth via shared storageState; requires E2E_TEST_EMAIL. Target: test.bizzassist.dk.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping ai-bbr-batch test');
  }
});

test.describe('AI hent_bbr_batch (BIZZ-2291)', () => {
  test('flere adresser → batch-BBR-værktøjet firer i ét kald', async ({ request }) => {
    test.setTimeout(120_000);
    const prompt =
      'Brug hent_bbr_batch-værktøjet til at hente BBR-data for disse tre adresser i ét kald: ' +
      'Rådhuspladsen 1, 1550 København; Banegårdspladsen 1, 8000 Aarhus; Bredgade 6, 5000 Odense C.';

    const res = await request.post('/api/ai/chat', {
      data: { messages: [{ role: 'user', content: prompt }] },
      timeout: 110_000,
    });
    expect(res.status()).toBe(200);

    const body = await res.text();
    // The batch tool must fire (its status label is deterministic when called).
    expect(body, 'hent_bbr_batch skulle være kaldt').toContain('Henter BBR for flere adresser');
  });
});
