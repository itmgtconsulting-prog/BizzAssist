import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BIZZ-2190: parseV2 skal akkumulere det FAKTISKE Anthropic-token-forbrug på
 * tværs af alle pipeline-kald og returnere det i V2ParseResult.usage, så parse-
 * routen kan registrere reelt forbrug mod brugerens kvote (recordAiUsage).
 *
 * Mocker Anthropic SDK så hvert messages.create returnerer kendt usage; kører
 * parseV2 og asserterer summen.
 */

// Hvert mocket Claude-kald returnerer en tom JSON-array + kendt usage.
const PER_CALL = { input_tokens: 100, output_tokens: 20 };
const createMock = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: '[]' }],
  usage: PER_CALL,
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { parseV2 } from '@/app/lib/forsikring/parserV2';

describe('parseV2 token-akkumulering (BIZZ-2190)', () => {
  beforeEach(() => createMock.mockClear());

  it('summerer input/output tokens fra alle Claude-kald i pipelinen', async () => {
    // Lille buffer (<150KB) → Step 0 går via Claude (ikke tekst-extraction).
    const tinyPdf = Buffer.from('%PDF-1.4 minimal');
    const result = await parseV2(tinyPdf, 'test-key');

    // Tom identifikation (step1 → []) → ingen step2/3; pipelinen kalder:
    // step0 (PDF→markdown) + step1 (identify) + step4 (conditions) = 3 kald.
    const n = createMock.mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(3);

    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(n * PER_CALL.input_tokens);
    expect(result.usage?.outputTokens).toBe(n * PER_CALL.output_tokens);
  });
});
