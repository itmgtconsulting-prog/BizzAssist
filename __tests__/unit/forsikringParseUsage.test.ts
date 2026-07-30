import { describe, it, expect } from 'vitest';
import { addUsage, type ParseTokenUsage } from '@/app/lib/forsikring/parserV2';

/**
 * BIZZ-2190: addUsage akkumulerer faktisk token-forbrug på tværs af de 5
 * pipeline-kald, så parse-routen kan registrere reelt forbrug mod kvoten.
 */
describe('addUsage (BIZZ-2190)', () => {
  it('summerer input+output på tværs af flere responses', () => {
    const acc: ParseTokenUsage = { inputTokens: 0, outputTokens: 0 };
    addUsage(acc, { usage: { input_tokens: 100, output_tokens: 20 } });
    addUsage(acc, { usage: { input_tokens: 5000, output_tokens: 800 } });
    addUsage(acc, { usage: { input_tokens: 30, output_tokens: 4 } });
    expect(acc).toEqual({ inputTokens: 5130, outputTokens: 824 });
  });

  it('håndterer manglende usage / felter som 0', () => {
    const acc: ParseTokenUsage = { inputTokens: 10, outputTokens: 2 };
    addUsage(acc, {});
    addUsage(acc, { usage: {} });
    addUsage(acc, { usage: { input_tokens: 7 } });
    expect(acc).toEqual({ inputTokens: 17, outputTokens: 2 });
  });

  it('er en no-op når akkumulatoren mangler (undefined)', () => {
    expect(() =>
      addUsage(undefined, { usage: { input_tokens: 1, output_tokens: 1 } })
    ).not.toThrow();
  });
});
