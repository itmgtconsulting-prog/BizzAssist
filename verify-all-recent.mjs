#!/usr/bin/env node
/**
 * Verification v2 — targets tab buttons inside company/ejendom detail pages
 * (not sidebar nav) and uses correct CVR for Arnbo 62 ApS.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('/root/BizzAssist/.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^"|"$/g, '')];
    })
);

const EMAIL = env.E2E_TEST_EMAIL;
const PASS = env.E2E_TEST_PASS;
if (!EMAIL || !PASS) throw new Error('Missing E2E creds');

const BASE = 'https://test.bizzassist.dk';
const OUT = '/tmp/verify_shots2';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[type="email"]').fill(EMAIL);
await page.locator('input[type="password"]').fill(PASS);
await page.locator('button[type="submit"]').click();
await page.waitForURL(/dashboard/, { timeout: 20000 });
console.log('✓ logged in');

/**
 * Click a tab inside a detail page by finding the tab container + matching text.
 * Scopes to role=tablist or tab-nav container to avoid sidebar false positives.
 */
async function clickDetailTab(tabName) {
  // Try by role first, fall back to button within the tab bar
  const roleTab = page.getByRole('tab', { name: new RegExp(`^\\s*${tabName}\\s*$`, 'i') }).first();
  if (await roleTab.count()) {
    await roleTab.click({ timeout: 4000 });
    return true;
  }
  // Fall back: look for a button with an lucide-icon before the text, inside any nav-like region.
  // The detail tabs render as <button class="..."><icon /><span>Name</span></button>
  const btns = page.locator('button').filter({ hasText: new RegExp(`^\\s*${tabName}\\s*$`, 'i') });
  const count = await btns.count();
  for (let i = 0; i < count; i++) {
    const b = btns.nth(i);
    // Skip sidebar nav by checking parent containers
    const isSidebar = await b.evaluate((el) => !!el.closest('aside, nav[class*="sidebar"]'));
    if (!isSidebar) {
      await b.click({ timeout: 4000 });
      return true;
    }
  }
  return false;
}

async function run(target) {
  const shots = [];
  console.log(`\n━━━ ${target.name}`);
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  const p0 = `${OUT}/${target.name}_0_initial.png`;
  await page.screenshot({ path: p0, fullPage: true });
  shots.push(p0);
  if (target.tab) {
    const ok = await clickDetailTab(target.tab);
    if (!ok) {
      console.log(`   ✗ tab "${target.tab}" not clickable`);
      return { name: target.name, shots, issues: [`tab-not-found:${target.tab}`] };
    }
    await page.waitForTimeout(target.wait ?? 10000);
    const p1 = `${OUT}/${target.name}_1_${target.tab.replace(/\W+/g, '_')}.png`;
    await page.screenshot({ path: p1, fullPage: true });
    shots.push(p1);
  }
  const body = await page.locator('body').innerText();
  const issues = [];
  for (const re of target.forbid ?? []) if (re.test(body)) issues.push(`forbidden:${re}`);
  for (const re of target.expect ?? []) if (!re.test(body)) issues.push(`missing:${re}`);
  console.log(`   ${issues.length ? '✗ ' + issues.join(', ') : '✓ OK'}`);
  return { name: target.name, shots, issues };
}

const targets = [
  // BIZZ-475 + BIZZ-461 — Arnbo 62 ApS (CVR 43924931)
  {
    name: 'arnbo_ejendomme',
    url: `${BASE}/dashboard/companies/43924931`,
    tab: 'Ejendomme',
    wait: 12000,
    expect: [/Arnold Nielsens Boulevard|BFE|2265[0-9]{2}/i],
  },
  {
    name: 'arnbo_virksomheder',
    url: `${BASE}/dashboard/companies/43924931`,
    tab: 'Virksomheder',
    wait: 6000,
  },
  // BIZZ-475 parent with historical subsidiaries — JaJR Holding ApS (CVR 41092807)
  {
    name: 'jajr_virksomheder',
    url: `${BASE}/dashboard/companies/41092807`,
    tab: 'Virksomheder',
    wait: 6000,
  },
  // BIZZ-476 AI article search — HP Properties ApS
  {
    name: 'hp_properties_oversigt',
    url: `${BASE}/dashboard/companies/41370025`,
    wait: 6000,
  },
];

const results = [];
for (const t of targets) results.push(await run(t));

await browser.close();

console.log('\n═══ Summary ═══');
for (const r of results) {
  console.log(`${r.issues.length ? '✗' : '✓'} ${r.name}${r.issues.length ? ' — ' + r.issues.join(', ') : ''}`);
}
console.log(`\nScreenshots: ${OUT}/`);
