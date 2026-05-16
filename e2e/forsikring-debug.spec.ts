/**
 * BIZZ-1592 — Live debug af 0/17 forsikrede bug.
 *
 * Stand-alone diagnostic: triggerer /api/bfe-addresses + /api/forsikring/analyser
 * for Belvedere (CVR 24301117) og dumper raw output så vi kan se hvilken
 * af de 5 mistanker (jf BIZZ-1592) der rammer.
 */
import { test, expect } from '@playwright/test';

const BELVEDERE_CVR = '24301117';
// 16 BFEs ejet af Belvedere ifølge ejf_ejerskab
const BELVEDERE_BFES = [
  237451, 237454, 237459, 239340, 5319038, 5319162, 5319347, 5322347, 5322348, 5322350, 5322351,
  5322352, 5322356, 5324007, 5324013, 5324015,
];

test.describe('BIZZ-1592 0/17 forsikrede debug', () => {
  test('1) /api/bfe-addresses returnerer adresser for Belvedere BFEs', async ({ page }) => {
    const url = `/api/bfe-addresses?bfes=${BELVEDERE_BFES.join(',')}`;
    const res = await page.request.get(url);
    expect(res.status()).toBe(200);
    const data = (await res.json()) as Record<string, { adresse: string | null }>;
    const totalBfes = Object.keys(data).length;
    const withAddr = Object.values(data).filter((d) => d.adresse).length;

    console.log(`[BIZZ-1592] bfe-addresses: ${withAddr}/${totalBfes} har adresse`);
    for (const [bfe, info] of Object.entries(data)) {
      console.log(`  BFE ${bfe} → adresse="${info.adresse ?? 'NULL'}"`);
    }
    expect(totalBfes).toBeGreaterThan(0);
  });

  test('2) /api/forsikring/analyser for Belvedere returnerer korrekte counts', async ({ page }) => {
    const res = await page.request.post('/api/forsikring/analyser', {
      data: {
        kunde_type: 'virksomhed',
        kunde_id: BELVEDERE_CVR,
        kunde_navn: 'BELVEDERE EJENDOMME A/S',
      },
    });
    expect(res.status()).toBe(200);
    const data = (await res.json()) as {
      total_aktiver?: number;
      insured_count?: number;
      uninsured_count?: number;
      matches?: Array<{
        aktiv: { label: string; adresse?: string | null; bfe?: number };
        bestMatch?: { score: number; policy: { policy_number?: string } } | null;
      }>;
    };

    console.log(
      `[BIZZ-1592] analyser: total=${data.total_aktiver}, insured=${data.insured_count}, uninsured=${data.uninsured_count}`
    );
    if (data.matches) {
      for (const m of data.matches.slice(0, 30)) {
        const status = m.bestMatch
          ? `INS (${m.bestMatch.score}, pol=${m.bestMatch.policy.policy_number})`
          : 'UNINSURED';

        console.log(
          `  ${status.padEnd(40)} bfe=${m.aktiv.bfe ?? '?'} adresse="${m.aktiv.adresse ?? 'NULL'}"`
        );
      }
    }
  });
});
