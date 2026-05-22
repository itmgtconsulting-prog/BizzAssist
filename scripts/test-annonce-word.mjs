/**
 * Test: Full annonce flow med Word output via AI Chat
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
import { mkdirSync } from 'fs';
config({ path: '.env.local' });
mkdirSync('/tmp/bizz-word-test', { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

// Capture API errors
page.on('response', async (res) => {
  if (res.url().includes('generate-file')) {
    const body = await res.text().catch(() => '');
    console.log(`[generate-file] ${res.status()} — ${body.slice(0, 300)}`);
  }
  if (res.url().includes('/api/ai/chat') && res.status() >= 400) {
    console.log(`[chat ERROR] ${res.status()}`);
  }
});

await page.goto('https://test.bizzassist.dk/login', { waitUntil: 'networkidle', timeout: 30000 });
await page.fill('input[type="email"]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type="password"]', process.env.E2E_TEST_PASS);
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard**', { timeout: 30000 });
try { await page.click('button:has-text("Acceptér alle")', { timeout: 3000 }); } catch {}

// Go to chat directly and ask for a simple Word doc
await page.goto('https://test.bizzassist.dk/dashboard/chat', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);

// Send a simple docx request
const input = await page.$('textarea, input[placeholder*="spørgsmål"]');
if (input) {
  await input.fill('Lav et Word-dokument med titlen "Testannonce Bjergvej 8" med en sektion heading="Bjergvej 8, 2620 Albertslund" og body="Dette er en test-annonce for Bjergvej 8. Ejendommen har 131 m² boligareal." Brug format=docx, mode=scratch.');
  await input.press('Enter');
  console.log('Sent request, waiting...');

  // Wait for response
  await page.waitForTimeout(30000);

  // Check for download chip
  const chip = await page.$('text=.docx');
  console.log('Download chip:', chip ? 'FOUND' : 'NOT FOUND');

  // Check for error text
  const errorText = await page.evaluate(() => {
    const el = document.querySelector('[class*="chat"]');
    const text = el?.textContent ?? '';
    if (text.includes('fejl') || text.includes('Fejl') || text.includes('error')) {
      return text.match(/[^.]*fejl[^.]*/gi)?.join(' | ') ?? 'error found but no match';
    }
    return 'no error';
  });
  console.log('Error in chat:', errorText);

  await page.screenshot({ path: '/tmp/bizz-word-test/result.png', fullPage: true });
}

await browser.close();
