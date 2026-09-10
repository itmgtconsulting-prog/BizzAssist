/**
 * E2E regression for the AI beregn_afstand tool — BIZZ-2286.
 *
 * Verifies the tool fires and returns a correct geodesic distance. Coordinates
 * are supplied explicitly so the result is deterministic (no geocoding variance):
 * Copenhagen (12.5683, 55.6761) → Aarhus (10.2039, 56.1572) ≈ 157 km great-circle.
 * (The address→coordinate path is verified live and documented in the ticket.)
 *
 * Auth via shared storageState; requires E2E_TEST_EMAIL. Target: test.bizzassist.dk.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping ai-afstand test');
  }
});

/** Concatenates the assistant text tokens (key `t`) from an SSE body. */
function assistantText(body: string): string {
  let out = '';
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as { t?: string };
      if (typeof obj.t === 'string') out += obj.t;
    } catch {
      /* ignore */
    }
  }
  return out;
}

test.describe('AI beregn_afstand (BIZZ-2286)', () => {
  test('beregner geodesisk afstand mellem to koordinater (~157 km)', async ({ request }) => {
    test.setTimeout(120_000);
    const prompt =
      'Brug beregn_afstand-værktøjet til at beregne den geodesiske afstand mellem to punkter: ' +
      'punkt 1 har lng 12.5683 og lat 55.6761, punkt 2 har lng 10.2039 og lat 56.1572. ' +
      'Svar med afstanden i km.';

    const res = await request.post('/api/ai/chat', {
      data: { messages: [{ role: 'user', content: prompt }] },
      timeout: 110_000,
    });
    expect(res.status()).toBe(200);

    const answer = assistantText(await res.text());
    // Great-circle CPH↔Aarhus ≈ 156.7 km — the answer should cite ~156/157 km.
    expect(answer, `svar skulle nævne km-afstand, fik: ${answer.slice(0, 300)}`).toMatch(/km/i);
    expect(answer).toMatch(/15[678]/);
  });
});
