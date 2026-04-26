// BIZZ-727 verification: log into test.bizzassist.dk, navigate to a property page,
// and confirm the Mapbox canvas renders (no "Kortvisning ikke aktiveret" fallback).
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

const EMAIL = env.E2E_TEST_EMAIL;
const PASS = env.E2E_TEST_PASS;
const URL = 'https://test.bizzassist.dk';
const PROPERTY = '/dashboard/ejendomme/3b362995-27a0-4c12-ad73-8ead0c978ad2';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Collect network: did the browser request a mapbox tile?
const mapboxRequests = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('api.mapbox.com') || u.includes('events.mapbox.com') || u.includes('tiles.mapbox.com')) {
    mapboxRequests.push(u.substring(0, 80));
  }
});

console.log('1. Login...');
await page.goto(URL + '/login');
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });
console.log('   → logged in, current URL:', page.url());

console.log('2. Navigate to property page...');
await page.goto(URL + PROPERTY, { waitUntil: 'networkidle', timeout: 30000 });

console.log('3. Look for fallback text or map canvas...');
// Wait up to 5s for either fallback OR canvas
await Promise.race([
  page.waitForSelector('text=Kortvisning ikke aktiveret', { timeout: 5000 }).catch(() => null),
  page.waitForSelector('.mapboxgl-canvas', { timeout: 10000 }).catch(() => null),
]);

const fallback = await page.locator('text=Kortvisning ikke aktiveret').count();
const canvas = await page.locator('.mapboxgl-canvas').count();
const mapContainer = await page.locator('.mapboxgl-map').count();

console.log();
console.log('═══ RESULT ═══');
console.log('  Fallback "Kortvisning ikke aktiveret":', fallback, fallback === 0 ? '✓ (not shown)' : '✗ (STILL SHOWN)');
console.log('  .mapboxgl-map containers:', mapContainer);
console.log('  .mapboxgl-canvas canvases:', canvas);
console.log('  Mapbox API network requests:', mapboxRequests.length);
if (mapboxRequests.length > 0) {
  console.log('    first 3:', mapboxRequests.slice(0, 3).join('\n              '));
}

const passed = fallback === 0 && (canvas > 0 || mapboxRequests.length > 0);
console.log();
console.log(passed ? '✓ PASS — map renders correctly' : '✗ FAIL — map not active');

await browser.close();
process.exit(passed ? 0 : 1);
