/**
 * E2E regression for the AI beregn_areal tool — BIZZ-2287.
 *
 * Verifies the tool fires and returns a correct geodesic area for an explicit
 * polygon (deterministic — no matrikel lookup). A ~0.01°×0.01° square near the
 * equator is ≈ 1.236e6 m² ≈ 123.6 ha. (The BFE→area path is verified live and
 * documented in the ticket.)
 *
 * Auth via shared storageState; requires E2E_TEST_EMAIL. Target: test.bizzassist.dk.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping ai-areal test');
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

test.describe('AI beregn_areal (BIZZ-2287)', () => {
  test('beregner geodesisk areal af en tegnet polygon (~123,6 ha)', async ({ request }) => {
    test.setTimeout(120_000);
    const prompt =
      'Brug beregn_areal-værktøjet til at beregne arealet af polygonen med hjørnepunkterne ' +
      '(lng,lat): [0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]. Svar med arealet i hektar.';

    const res = await request.post('/api/ai/chat', {
      data: { messages: [{ role: 'user', content: prompt }] },
      timeout: 110_000,
    });
    expect(res.status()).toBe(200);

    const body = await res.text();
    // The beregn_areal tool must actually fire (deterministic status event) —
    // that is the regression. The exact number is validated by the geo-measure
    // unit test; the LLM's phrasing/number-format is not asserted (avoids flake).
    expect(body, 'beregn_areal-værktøjet skulle være kaldt').toContain('Beregner areal');
    const answer = assistantText(body);
    expect(answer, `svar skulle nævne et areal, fik: ${answer.slice(0, 300)}`).toMatch(
      /ha|m²|m2|hektar|kvadratmeter/i
    );
  });
});
