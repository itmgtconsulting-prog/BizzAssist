const { chromium } = require('playwright-core');
const path = require('path');

const BASE = 'https://test.bizzassist.dk';
const EMAIL = 'jjrchefen@gmail.com';
const PASS = 'Kongen72';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log('1. Logging in...');
  await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 30000 });
  console.log('   OK: ' + page.url());

  try {
    const close = page.locator('[aria-label="Luk"], button:has-text("Luk"), button:has-text("Skip")');
    if (await close.first().isVisible({ timeout: 3000 })) { await close.first().click(); await page.waitForTimeout(500); }
  } catch {}

  // 1. Forsikrings-gap dropdown
  console.log('\n2. Forsikrings-gap dropdown (BIZZ-1278/1279)...');
  await page.goto(BASE + '/dashboard/analyse/forsikring', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.locator('input[placeholder*="Søg"]').first().fill('jakob');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/test-01-dropdown.png' });
  console.log('   Saved: /tmp/test-01-dropdown.png');

  // 2. Trin 2 fritekst
  console.log('\n3. Trin 2 fritekst (BIZZ-1280/1281)...');
  try {
    await page.locator('button:has-text("Jakob Juul")').first().click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.locator('button:has-text("Næste")').click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/tmp/test-02-trin2.png' });
    console.log('   Saved: /tmp/test-02-trin2.png');
  } catch (e) { console.log('   SKIP: ' + e.message.slice(0,80)); }

  // 3. Pivot Analyse
  console.log('\n4. Pivot Analyse (BIZZ-1269)...');
  await page.goto(BASE + '/dashboard/analyse/pivot', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/test-03-pivot.png' });
  console.log('   Saved: /tmp/test-03-pivot.png');

  // 4. AI Query Builder
  console.log('\n5. AI Query Builder (BIZZ-1262/1283)...');
  await page.goto(BASE + '/dashboard/analyse/data', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/test-04-querybuilder.png' });
  console.log('   Saved: /tmp/test-04-querybuilder.png');

  // 5. Virksomhed diagram
  console.log('\n6. Virksomhedsdiagram (BIZZ-1285)...');
  await page.goto(BASE + '/dashboard/companies/41092807', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  try {
    await page.locator('button:has-text("Diagram"), [role="tab"]:has-text("Diagram")').first().click({ timeout: 5000 });
    await page.waitForTimeout(3000);
  } catch {}
  await page.screenshot({ path: '/tmp/test-05-diagram.png' });
  console.log('   Saved: /tmp/test-05-diagram.png');

  // 6. Ejendom
  console.log('\n7. Ejendomsside (BIZZ-1230)...');
  await page.goto(BASE + '/dashboard/ejendomme/0a3f507c-e46f-32b8-e044-0003ba298018', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/test-06-ejendom.png' });
  console.log('   Saved: /tmp/test-06-ejendom.png');

  await browser.close();
  console.log('\nDone — 6 screenshots');
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
