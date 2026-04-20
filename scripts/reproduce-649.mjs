#!/usr/bin/env node
/**
 * BIZZ-649 root-cause probe: call /api/ai/chat as E2E test user and observe
 * whether gate blocks or lets through. Check subscription-state in DB to
 * understand which code path fires.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE = 'https://test.bizzassist.dk';

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('domcontentloaded');
  const c = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await c.isVisible({ timeout: 2000 }).catch(() => false)) await c.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
await login(page);
console.log(`Login OK som: ${process.env.E2E_TEST_EMAIL}\n`);

// 1. Call /api/ai/chat with a trivial payload to see gate response
console.log('═══ Probe 1: POST /api/ai/chat ═══');
const resp1 = await page.evaluate(async () => {
  const r = await fetch('/api/ai/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
  });
  const text = await r.text();
  return { status: r.status, body: text.slice(0, 500) };
});
console.log(`HTTP ${resp1.status}`);
console.log(`Body: ${resp1.body}\n`);

// 2. Check user's subscription status via session API
console.log('═══ Probe 2: GET /api/auth/session (if exists) or user metadata ═══');
const resp2 = await page.evaluate(async () => {
  // Try common endpoints for user-info
  for (const path of ['/api/auth/user', '/api/user', '/api/auth/session', '/api/billing/status']) {
    const r = await fetch(path, { credentials: 'include' });
    if (r.ok) return { path, status: r.status, body: (await r.text()).slice(0, 500) };
  }
  return { error: 'no user endpoint found' };
});
console.log(JSON.stringify(resp2, null, 2));

// 3. Test via tokens-status endpoint
console.log('\n═══ Probe 3: Token-status endpoint (if exists) ═══');
const resp3 = await page.evaluate(async () => {
  const r = await fetch('/api/tokens/status', { credentials: 'include' });
  if (!r.ok) return { status: r.status, body: (await r.text()).slice(0, 300) };
  return await r.json();
});
console.log(JSON.stringify(resp3, null, 2));

await browser.close();
