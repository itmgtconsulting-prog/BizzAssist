import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const JAKOB_ENHEDSNR = '4000115446';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) testInfo.skip(true, 'No E2E auth');
});

test('BIZZ-1588: enhedsNummer-only returns >0 ejendomme via cache', async ({ page }) => {
  const url = `/api/ejendomme-by-owner?enhedsNummer=${JAKOB_ENHEDSNR}`;
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  const data = (await res.json()) as Record<string, unknown>;
  console.log(`[BIZZ-1588] FULL RESPONSE:`, JSON.stringify(data).slice(0, 1500));
  expect(data.totalBfe).toBeGreaterThan(0);
  expect(((data.ejendomme as unknown[]) ?? []).length).toBeGreaterThan(0);
});
