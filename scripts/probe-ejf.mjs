/**
 * Playwright: log ind i test.bizzassist.dk og hent /api/ejerskab/raw?bfeNummer=X
 * så vi kan se hvilke person-felter EJF GraphQL faktisk eksponerer.
 *
 * BFE 2081243 = Søbyvej 11 (kendt ejet af Jakob Juul Rasmussen).
 */
import { chromium } from 'playwright';

const EMAIL = 'jjrchefen@gmail.com';
const PASS = 'Kongen72';
const BASE = 'https://test.bizzassist.dk';
const BFE = process.argv[2] ?? '2081243';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Login
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const cookieAccept = page.getByRole('button', { name: /Acceptér alle|Accepter alle/i }).first();
if (await cookieAccept.isVisible({ timeout: 3000 }).catch(() => false)) {
  await cookieAccept.click();
  await page.waitForTimeout(500);
}
await page.getByPlaceholder('navn@virksomhed.dk').fill(EMAIL);
await page.getByPlaceholder('••••••••').fill(PASS);
await page.getByRole('button', { name: /^Log ind$/i }).click();
await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 60000 }).catch(() => null);
await page.waitForTimeout(3000);
console.error(`[info] post-login URL: ${page.url()}`);

// Navigate to a dashboard page first to ensure Supabase session is hydrated,
// then call the API via the browser's fetch so cookies + auth are included
// via the same path real UI uses.
await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// Debug: dump cookies
const cookies = await ctx.cookies();
console.error(
  '[cookies]',
  cookies.map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly }))
);

// Sanity check: existing /api/ejerskab should work if session is valid
const sanityUrl = `${BASE}/api/ejerskab?bfeNummer=${BFE}`;
console.error(`[sanity] fetching ${sanityUrl}`);
const sanity = await page.evaluate(async (url) => {
  const r = await fetch(url, { credentials: 'include' });
  return { status: r.status, body: await r.text() };
}, sanityUrl);
console.error(`[sanity] HTTP ${sanity.status}, body preview: ${sanity.body.slice(0, 200)}`);

const rawUrl = `${BASE}/api/ejerskab/raw?bfeNummer=${BFE}`;
console.error(`[info] fetching ${rawUrl} via page.evaluate`);
const { status, body } = await page.evaluate(async (url) => {
  const r = await fetch(url, { credentials: 'include' });
  const txt = await r.text();
  return { status: r.status, body: txt };
}, rawUrl);
console.error(`[info] HTTP ${status}`);

// Try pretty-print
try {
  const json = JSON.parse(body);
  console.log(JSON.stringify(json, null, 2));
} catch {
  console.log(body);
}

await browser.close();
