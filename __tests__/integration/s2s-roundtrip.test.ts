/**
 * Integration test for S2S Tinglysning roundtrip (BIZZ-1527).
 *
 * Kører ECHTE kald mod prod XML API kun når RUN_S2S_INTEGRATION=true er sat.
 * Skipper helt ellers — så normal `npm test` ikke kræver OCES-cert.
 *
 * Verificerer at:
 *   1. Live response shape matcher fixture-shape (key XML elementer findes)
 *   2. Signing accepteres af Tinglysning (200 OK)
 *   3. Round-trip total tid er rimelig (< 30s)
 *
 * Bruger BFE 100165718 = officiel test-ejendom i test.tinglysning.dk.
 *
 * Krav til miljø før kørsel:
 *   - TINGLYSNING_CERT_B64 + TINGLYSNING_CERT_PASSWORD sat (OCES P12)
 *   - DF_PROXY_URL + DF_PROXY_SECRET (Hetzner mTLS-proxy)
 *   - RUN_S2S_INTEGRATION=true
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { callS2S, NS } from '@/app/lib/s2sClient';

const RUN = process.env.RUN_S2S_INTEGRATION === 'true';
const TEST_BFE = process.env.S2S_TEST_BFE ?? '100165718';

// describe.skipIf undlader hele suite hvis RUN er false
describe.skipIf(!RUN)('S2S roundtrip integration', () => {
  beforeAll(() => {
    const missing: string[] = [];
    if (!process.env.TINGLYSNING_CERT_B64) missing.push('TINGLYSNING_CERT_B64');
    if (!process.env.TINGLYSNING_CERT_PASSWORD) missing.push('TINGLYSNING_CERT_PASSWORD');
    if (!process.env.DF_PROXY_URL) missing.push('DF_PROXY_URL');
    if (!process.env.DF_PROXY_SECRET) missing.push('DF_PROXY_SECRET');
    if (missing.length > 0) {
      throw new Error(`S2S integration kræver env: ${missing.join(', ')}`);
    }
  });

  it('EjendomSummariskHent returnerer BFE+Adresse', async () => {
    const start = Date.now();
    const xml = await callS2S(
      'EjendomSummariskHent',
      `<EjendomSummariskHent xmlns="${NS.MSG}"><BFEnummer>${TEST_BFE}</BFEnummer></EjendomSummariskHent>`,
      { timeoutMs: 30_000 }
    );
    expect(Date.now() - start).toBeLessThan(30_000);
    expect(xml).toContain('BFEnummer');
    expect(xml).toContain(TEST_BFE);
  }, 35_000);

  it('EjendomAdkomsterHent returnerer adkomster-struktur', async () => {
    const xml = await callS2S(
      'EjendomAdkomsterHent',
      `<EjendomAdkomsterHent xmlns="${NS.MSG}"><BFEnummer>${TEST_BFE}</BFEnummer></EjendomAdkomsterHent>`,
      { timeoutMs: 30_000 }
    );
    expect(xml).toMatch(/Adkomster|Adkomst/);
  }, 35_000);

  it('EjendomServitutterHent returnerer servitut-struktur', async () => {
    const xml = await callS2S(
      'EjendomServitutterHent',
      `<EjendomServitutterHent xmlns="${NS.MSG}"><BFEnummer>${TEST_BFE}</BFEnummer></EjendomServitutterHent>`,
      { timeoutMs: 30_000 }
    );
    expect(xml).toMatch(/Servitut/);
  }, 35_000);

  it('EjendomHaeftelserHent returnerer haeftelse-struktur', async () => {
    const xml = await callS2S(
      'EjendomHaeftelserHent',
      `<EjendomHaeftelserHent xmlns="${NS.MSG}"><BFEnummer>${TEST_BFE}</BFEnummer></EjendomHaeftelserHent>`,
      { timeoutMs: 30_000 }
    );
    expect(xml).toMatch(/Haeftelse/);
  }, 35_000);
});
