const { chromium } = require('playwright-core');

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
  console.log('   OK');

  // Dismiss cookie + onboarding
  try { await page.locator('button:has-text("Acceptér alle")').click({ timeout: 3000 }); } catch {}
  try {
    const close = page.locator('[aria-label="Luk"], button:has-text("Luk"), button:has-text("Skip")');
    if (await close.first().isVisible({ timeout: 2000 })) await close.first().click();
  } catch {}

  // 1. Forsikrings-gap — find the RIGHT search input (inside the card, not topbar)
  console.log('\n2. Forsikrings-gap dropdown...');
  await page.goto(BASE + '/dashboard/analyse/forsikring', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  // The forsikring search input has placeholder "Søg efter person eller virksomhed..."
  const forsikringInput = page.locator('input[placeholder*="person eller virksomhed"]');
  if (await forsikringInput.isVisible({ timeout: 3000 })) {
    await forsikringInput.fill('jakob');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: '/tmp/test-01-dropdown.png', fullPage: false });
    console.log('   OK — dropdown screenshot');
    
    // Select first person and go to Trin 2
    try {
      await page.locator('button:has-text("Jakob Juul Rasmussen")').first().click({ timeout: 5000 });
      await page.waitForTimeout(500);
      await page.locator('button:has-text("Næste")').click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: '/tmp/test-02-trin2.png' });
      console.log('   OK — trin 2 screenshot');
    } catch (e) { console.log('   Trin 2 skip: ' + e.message.slice(0,60)); }
  } else {
    console.log('   WARN: forsikring input not found');
    await page.screenshot({ path: '/tmp/test-01-dropdown.png' });
  }

  // 2. Pivot — check DataModelPanel
  console.log('\n3. Pivot Analyse...');
  await page.goto(BASE + '/dashboard/analyse/pivot', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/test-03-pivot.png' });
  console.log('   OK');

  // 3. Query Builder
  console.log('\n4. AI Query Builder...');
  await page.goto(BASE + '/dashboard/analyse/data', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/test-04-querybuilder.png' });
  console.log('   OK');

  // 4. Virksomhed + diagram tab
  console.log('\n5. Virksomhedsdiagram...');
  await page.goto(BASE + '/dashboard/companies/41092807', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  try {
    await page.locator('button:has-text("Diagram"), a:has-text("Diagram")').first().click({ timeout: 5000 });
    await page.waitForTimeout(4000);
  } catch {}
  await page.screenshot({ path: '/tmp/test-05-diagram.png' });
  console.log('   OK');

  // 5. Ejendom
  console.log('\n6. Ejendomsside...');
  await page.goto(BASE + '/dashboard/ejendomme/0a3f507c-e46f-32b8-e044-0003ba298018', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/test-06-ejendom.png' });
  console.log('   OK');

  await browser.close();
  console.log('\nDone');
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
