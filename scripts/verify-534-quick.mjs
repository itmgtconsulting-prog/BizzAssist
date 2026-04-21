#!/usr/bin/env node
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto('https://test.bizzassist.dk/login');
await p.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await p.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([p.waitForURL(/dashboard/), p.click('button[type=submit]')]);
const r = await p.evaluate(async () => {
  const x = await fetch(
    '/api/ejerskab/person-properties?navn=Jakob%20Juul%20Rasmussen&fdato=1972-07-11'
  );
  return { status: x.status, body: await x.text() };
});
console.log(r.status, r.body.slice(0, 500));
await b.close();
