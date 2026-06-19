/**
 * BIZZ-2144: DMR-berigelse af bilforsikringspolicer.
 *
 * Verificerer at proxy-endpointet /api/dmr/regnr/[regnr] slår et
 * registreringsnummer op mod Motorregistret (via tjekbil.dk) og returnerer
 * normaliseret DmrData — datakilden som gap-motoren bruger til at opdage at en
 * bil er afmeldt, uforsikret, forsikret hos andet selskab eller mangler syn.
 *
 * To assertions:
 *   1. Gyldigt regnr (CE18728) → 200 med dmr-objekt (regNr + status + mærke).
 *   2. Ugyldigt regnr → 400 (input-sanitering før external opslag).
 *
 * Read-only: ingen skrivninger, ingen tenant-forurening. Kører mod
 * test.bizzassist.dk (develop) med gemt auth-state.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

interface DmrResponse {
  dmr: {
    regNr: string;
    status: string | null;
    maerke: string | null;
    forsikringSelskab: string | null;
  } | null;
}

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping DMR-berigelse test');
  }
});

test.describe('DMR-berigelse via reg.nr-opslag (BIZZ-2144)', () => {
  test('gyldigt regnr returnerer normaliseret køretøjsdata', async ({ request }) => {
    const res = await request.get('/api/dmr/regnr/CE18728', { timeout: 30_000 });
    expect(res.status()).toBe(200);
    const { dmr } = (await res.json()) as DmrResponse;
    expect(dmr, 'DMR-opslag gav intet køretøj').toBeTruthy();
    expect(dmr!.regNr).toBe('CE18728');
    // Køretøjet er en kendt registreret VW i DMR — bekræfter at parsing virker.
    expect(dmr!.status).toBeTruthy();
    expect(dmr!.maerke).toBeTruthy();
  });

  test('ugyldigt regnr afvises med 400 (input-sanitering)', async ({ request }) => {
    const res = await request.get('/api/dmr/regnr/NOTAREG', { timeout: 15_000 });
    expect(res.status()).toBe(400);
  });
});
