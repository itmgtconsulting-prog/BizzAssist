import { chromium, devices } from 'playwright';
const b = await chromium.launch({ headless: true });
const iphone = devices['iPhone 13'];
const ctx = await b.newContext({ ...iphone });
const page = await ctx.newPage();
await page.goto('https://bizzassist.dk/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/mobile-home.png', fullPage: false });
console.log('screenshot: /tmp/mobile-home.png');
// Check widget bbox
const widget = await page.locator('button[aria-label="Support"]').boundingBox().catch(() => null);
const vp = iphone.viewport;
console.log('viewport:', vp.width, 'x', vp.height);
console.log('widget bbox:', widget);
await b.close();
