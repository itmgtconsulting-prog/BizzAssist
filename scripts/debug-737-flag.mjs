import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
      return m ? [m[1], m[2]] : [null, null];
    })
    .filter(([k]) => k)
);
const URL = 'https://test.bizzassist.dk';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

page.on('console', (m) => console.log('CONSOLE:', m.text().slice(0, 300)));

await page.goto(URL + '/login');
await page.fill('input[type=email]', env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', env.E2E_TEST_PASS);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

await page.goto(URL + '/dashboard/admin/users', { timeout: 20000 });
await page.waitForTimeout(3500);

console.log('URL:', page.url());
console.log('TITLE:', await page.title());
const body = await page.locator('body').textContent();
console.log('BODY (first 400):', body?.slice(0, 400));

// Find all links pointing at /dashboard/admin/*
const adminLinks = await page.$$eval(
  'a[href^="/dashboard/admin/"]',
  (els) => els.map((e) => ({ text: e.textContent?.trim(), href: e.getAttribute('href') }))
);
console.log('\n=== All admin links on users page ===');
for (const l of adminLinks) console.log(`  ${l.href.padEnd(50)} "${l.text?.slice(0, 40)}"`);

// Check for Domains text anywhere
const domainsLinks = await page.$$eval(
  'a',
  (els) =>
    els
      .filter((e) => e.textContent?.trim() === 'Domains')
      .map((e) => ({ text: e.textContent?.trim(), href: e.getAttribute('href') }))
);
console.log('\n=== Elements with text "Domains" ===', domainsLinks);

// Dump bundle env check — call the runtime check
const envCheck = await page.evaluate(() => {
  // process.env is only available server-side in Next, but NEXT_PUBLIC_ vars
  // get baked into the client bundle as string literals. We can't read them
  // directly from window but we can check HTML for tabs.
  const tabs = Array.from(document.querySelectorAll('a, span')).filter((e) =>
    /^(Users|Brugere|Billing|Fakturering|Planer|Plans|Domains|Security|Sikkerhed)$/i.test(
      e.textContent?.trim() ?? ''
    )
  );
  return tabs.map((t) => ({ tag: t.tagName, text: t.textContent?.trim(), href: t.getAttribute?.('href') }));
});
console.log('\n=== Tab elements in DOM ===');
for (const t of envCheck) console.log(`  ${t.tag.padEnd(5)} ${(t.href ?? '').padEnd(45)} "${t.text}"`);

await browser.close();
