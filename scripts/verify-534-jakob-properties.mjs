#!/usr/bin/env node
/**
 * BIZZ-534 verifikation: Jakob Juul Rasmussens person-side skal vise hans
 * personligt ejede ejendomme (Søbyvej 11, Hovager 8, Vigerslevvej 146)
 * via ejf_ejerskab-bulk-indekset.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const BASE = 'https://test.bizzassist.dk';
const JAKOB_ENHEDSNR = '4000115446';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([
  page.waitForURL(/dashboard/, { timeout: 30000 }),
  page.click('button[type=submit]'),
]);

// 1. person-bridge: enhedsNummer → navn + fødselsdato
const bridge = await page.evaluate(async (enhedsNr) => {
  const r = await fetch(`/api/ejerskab/person-bridge?enhedsNummer=${enhedsNr}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}, JAKOB_ENHEDSNR);
console.log('person-bridge:', bridge.status, JSON.stringify(bridge.body));

// 2. person-properties: navn + fødselsdato → BFE-liste
if (bridge.body?.navn) {
  const props = await page.evaluate(async (body) => {
    const r = await fetch(
      `/api/ejerskab/person-properties?navn=${encodeURIComponent(body.navn)}&fdato=${body.foedselsdato ?? ''}`
    );
    return { status: r.status, body: await r.json().catch(() => null) };
  }, bridge.body);
  console.log('person-properties:', props.status);
  const bfes = props.body?.bfes || props.body?.ejendomme || [];
  console.log('BFE count:', bfes.length);
  if (bfes.length) {
    console.log('sample:', JSON.stringify(bfes.slice(0, 5), null, 2));
  }
  fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
  fs.writeFileSync(
    '/tmp/verify-screenshots/results-534.json',
    JSON.stringify({ bridge: bridge.body, properties: props.body }, null, 2)
  );
}

await browser.close();
