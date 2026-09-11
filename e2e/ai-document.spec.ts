/**
 * E2E regression test for AI-chat document generation — BIZZ-2290.
 *
 * The generate_document tool never fired for larger requests because max_tokens
 * (4096) truncated the tool_use JSON. This locks that generate_document DOES
 * fire and returns a downloadable file for an explicit Excel request.
 *
 * The request supplies the rows INLINE so the model needs a single
 * generate_document call (no data-gathering tool rounds) — deterministic and
 * cheap, while still exercising the tool_use → file path that was broken.
 *
 * Auth: tenant member via shared storageState. Requires E2E_TEST_EMAIL; skipped
 * otherwise. Target: test.bizzassist.dk.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping ai-document tests');
  }
});

/** Extracts the first `generated_file` event from an SSE response body. */
function findGeneratedFile(body: string): { file_name?: string; format?: string } | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as {
        generated_file?: { file_name?: string; format?: string };
      };
      if (obj.generated_file) return obj.generated_file;
    } catch {
      /* ignore non-JSON keepalive lines */
    }
  }
  return null;
}

test.describe('AI-chat dokument-generering (BIZZ-2290)', () => {
  test('eksplicit Excel-forespørgsel med inline data → generate_document leverer en fil', async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const prompt =
      'Lav en Excel-fil (xlsx) med kolonnerne Navn og By og præcis disse 3 rækker: ' +
      'Anders Andersen / København, Bo Bosen / Aarhus, Cecilie Cecsen / Odense. ' +
      'Kald generate_document med mode=scratch og format=xlsx nu.';

    const res = await request.post('/api/ai/chat', {
      data: { messages: [{ role: 'user', content: prompt }] },
      timeout: 110_000,
    });
    expect(res.status()).toBe(200);

    const file = findGeneratedFile(await res.text());
    expect(file, 'et generate_document generated_file-event skal være streamet').not.toBeNull();
    expect(file?.format).toBe('xlsx');
  });
});
