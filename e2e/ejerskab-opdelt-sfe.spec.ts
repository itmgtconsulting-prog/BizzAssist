/**
 * Ejerskab: opdelt SFE regression (BIZZ-2193).
 *
 * En SFE/hovedejendom opdelt i ejerlejligheder viste ejeren som "Ukendt 100%",
 * fordi EJF repræsenterer SFE-niveauets ejer som en navnløs 1/1-placeholder.
 * Efter fixet mappes placeholderen til status-teksten "Opdelt i ejerlejligheder".
 *
 * Verificerer mod /api/ejerskab/chain (kilden bag Ejerskab-fanen) for BFE 2160256
 * (Hammerholmen 48A, opdelt SFE) at (a) der IKKE er en reel ejer "Ukendt 100%",
 * og (b) at ejendommen markeres som opdelt.
 *
 * @module e2e/ejerskab-opdelt-sfe.spec
 */

import { test, expect } from '@playwright/test';

/** BFE for en opdelt SFE (Hammerholmen 48A) — jf. BIZZ-2193 reproduktion. */
const OPDELT_SFE_BFE = 2160256;

interface ChainEjerDetalje {
  navn?: string | null;
  type?: string | null;
  andel?: string | null;
}

test.describe('Ejerskab opdelt SFE (BIZZ-2193)', () => {
  test('opdelt SFE viser "Opdelt i ejerlejligheder", ikke "Ukendt 100%"', async ({
    page,
    baseURL,
  }) => {
    const base = baseURL ?? 'https://test.bizzassist.dk';
    // Warm authenticated session så fetch arver cookies.
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });

    const data = await page.evaluate(async (url) => {
      const r = await fetch(url);
      return r.ok ? await r.json() : { _status: r.status };
    }, `${base}/api/ejerskab/chain?bfe=${OPDELT_SFE_BFE}`);

    expect(data?._status, 'chain-endpoint skal svare 200 (authenticated)').toBeUndefined();
    const detaljer: ChainEjerDetalje[] = data?.ejerDetaljer ?? [];

    // (a) Ingen REEL ejer ved navn "Ukendt" med 100% andel (det misvisende symptom).
    const ukendt100 = detaljer.find(
      (d) =>
        (d.navn ?? '').trim().toLowerCase() === 'ukendt' &&
        d.type !== 'status' &&
        (d.andel ?? '').replace(/\s/g, '') === '100%'
    );
    expect(ukendt100, 'opdelt SFE må ikke vise "Ukendt 100%" som ejer').toBeFalsy();

    // (b) Markeret som opdelt (status-tekst fra fixet).
    const erOpdelt = detaljer.some((d) => /opdelt i ejerlejlighed/i.test(d.navn ?? ''));
    expect(erOpdelt, 'opdelt SFE skal vise status "Opdelt i ejerlejligheder"').toBeTruthy();
  });
});
