/**
 * BIZZ-2162: backfill_1831_cvr_addr-poisoning af bfe_adresse_cache.
 *
 * backfill_1831 skrev virksomhedens CVR-hovedkontoradresse ("Torvegade 5A")
 * som ejendomsadresse for 2 BFE'er på Familien Petersen Ejendomme A/S, så de
 * dukkede op som dubletter under "Ejendomme uden virksomheds-tilknytning".
 *
 * Fixet: backfill_1831_cvr_addr er nu en utroværdig cache-kilde, og de 3699
 * poisoned rækker er purged i alle 3 miljøer → resolveren (hentBfeAdresser,
 * brugt af både /api/bfe-addresses og forsikrings-koncernWalk) re-resolver
 * korrekt pr. BFE via DAWA-jordstykke.
 *
 * Verifikation via /api/bfe-addresses (samme resolver-kodevej som gap-analysen):
 *   BFE 5318964 → Bjergegade 27A (matrikel 227a), IKKE Torvegade 5A
 *   BFE 5319041 → Strandgade 59A (matrikel 291),  IKKE Torvegade 5A
 *
 * Kører mod test.bizzassist.dk (develop) med gemt auth-state.
 */
import { test, expect } from '@playwright/test';
import { AUTH_STATE_PATH } from './helpers';

test.use({ storageState: AUTH_STATE_PATH });

test('BIZZ-2162: poisoned BFE-adresser re-resolves korrekt (ikke Torvegade 5A)', async ({
  page,
}) => {
  const r = await page.request.get('/api/bfe-addresses?bfes=5318964,5319041');
  expect(r.ok()).toBeTruthy();
  const out = await r.json();

  // Begge BFE'er må ALDRIG vise virksomhedens CVR-adresse længere.
  expect(out['5318964']?.adresse).not.toBe('Torvegade 5A');
  expect(out['5319041']?.adresse).not.toBe('Torvegade 5A');

  // Korrekte matrikel-beliggenhedsadresser fra DAWA-jordstykke.
  expect(out['5318964']?.adresse).toBe('Bjergegade 27A');
  expect(out['5319041']?.adresse).toBe('Strandgade 59A');
});
