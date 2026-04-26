import { chromium, devices } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const b = await chromium.launch({ headless: true });
const iphone = devices['iPhone 13'];
const ctx = await b.newContext({ ...iphone });
const page = await ctx.newPage();

// Log in
await page.goto('https://bizzassist.dk/login', { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([
  page.waitForURL(/dashboard/, { timeout: 30000 }).catch(() => null),
  page.click('button[type=submit]'),
]);
await page.waitForTimeout(5000);

// All fixed-position elements on the page
const rects = await page.evaluate(() => {
  const els = document.querySelectorAll('*');
  const fixed = [];
  els.forEach((el) => {
    const s = getComputedStyle(el);
    if (s.position === 'fixed' && s.display !== 'none' && s.visibility !== 'hidden') {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        fixed.push({
          tag: el.tagName.toLowerCase(),
          aria: el.getAttribute('aria-label') || '',
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          cls: (el.className || '').toString().slice(0, 120),
        });
      }
    }
  });
  return { viewport: { w: window.innerWidth, h: window.innerHeight }, fixed };
});
console.log('viewport:', rects.viewport);
rects.fixed.forEach((f) => console.log(`  ${f.tag} "${f.aria}" x=${f.x} y=${f.y} ${f.w}x${f.h} cls="${f.cls}"`));

await page.screenshot({ path: '/tmp/mobile-dashboard.png', fullPage: false });
console.log('screenshot: /tmp/mobile-dashboard.png');
await b.close();
