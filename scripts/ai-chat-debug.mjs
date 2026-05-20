#!/usr/bin/env node
/**
 * Debug AI chat — single question, dismiss cookie banner, full visibility.
 */
import { chromium } from 'playwright';

const BASE_URL = 'https://test.bizzassist.dk';
const EMAIL = 'jjrchefen@gmail.com';
const PASSWORD = 'Kongen72';
const QUESTION = 'Hvad er byggeåret for Vigerslevvej 146, 1. th, 2500 Valby?';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  // Login
  console.log('1. Logging in...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 15000 });
  console.log('   ✅ Logged in');

  // Dismiss cookie banner
  console.log('2. Dismissing cookie banner...');
  try {
    await page.click('button:has-text("Accepter alle")', { timeout: 3000 });
    console.log('   ✅ Cookie banner dismissed');
  } catch {
    console.log('   No cookie banner found');
  }
  await page.waitForTimeout(1000);

  // Dismiss 2FA banner if present
  try {
    const closeBtn = page.locator('button[aria-label="close"], button:near(:text("2FA"))').first();
    await closeBtn.click({ timeout: 2000 });
    console.log('   ✅ 2FA banner dismissed');
  } catch {
    console.log('   No 2FA banner to dismiss');
  }

  // Open AI Chat sidebar (not fullscreen page) via top-right button
  console.log('3. Opening AI Chat...');
  try {
    // Try the top-right "AI Chat" button first (opens sidebar panel)
    const topBtn = page.locator('button:has-text("AI Chat")').first();
    await topBtn.click({ timeout: 3000 });
    console.log('   ✅ AI Chat sidebar opened via top button');
  } catch {
    // Fallback to sidebar nav
    await page.click('text=AI Chat', { timeout: 5000 });
    console.log('   ✅ AI Chat page opened via sidebar');
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/ai-chat-debug-1.png' });

  // Find and log ALL inputs on the page
  console.log('4. Finding chat input...');
  const allInputs = await page.locator('input, textarea').all();
  for (let i = 0; i < allInputs.length; i++) {
    const tag = await allInputs[i].evaluate(el => el.tagName);
    const type = await allInputs[i].getAttribute('type');
    const ph = await allInputs[i].getAttribute('placeholder');
    const visible = await allInputs[i].isVisible();
    if (ph || visible) console.log(`   ${tag} type="${type}" placeholder="${ph}" visible=${visible}`);
  }

  // Type question
  console.log('5. Sending question...');
  const chatInput = page.locator('input[placeholder*="spørgsmål" i], input[placeholder*="Stil" i], input[placeholder*="Ask" i]').first();
  await chatInput.waitFor({ timeout: 5000 });
  await chatInput.fill(QUESTION);
  await page.screenshot({ path: '/tmp/ai-chat-debug-2-typed.png' });
  await chatInput.press('Enter');
  console.log('   ✅ Sent');

  // Listen for network requests to /api/ai/chat
  console.log('6. Monitoring network...');
  page.on('response', (response) => {
    if (response.url().includes('/api/ai/')) {
      console.log(`   [NET] ${response.status()} ${response.url().split('?')[0]}`);
    }
  });

  // Wait and observe
  console.log('7. Waiting for response...');
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000);
    const elapsed = (i + 1) * 5;

    // Get ALL text content from the chat area (right side of the page)
    const chatArea = page.locator('main, [class*="chat"], [class*="message"], [class*="flex-col"]');
    const areaCount = await chatArea.count();

    // Look for any element that could be an AI response
    // Check for blue user messages and non-blue assistant messages
    const userMsgs = await page.locator('div:has-text("byggeår")').count();

    // Get the page's text content to see what changed
    const bodyText = await page.evaluate(() => {
      // Find the main chat content area
      const main = document.querySelector('main') || document.body;
      return main.innerText.substring(0, 2000);
    });

    // Check for new content that wasn't there before
    if (bodyText.includes('1940') || bodyText.includes('bygningsår') || bodyText.includes('opført')) {
      console.log(`\n   ✅ ${elapsed}s — AI RESPONSE FOUND!`);
      console.log(bodyText.substring(0, 500));
      break;
    }

    // Log status
    const textLen = bodyText.length;
    console.log(`   ${elapsed}s | body text: ${textLen} chars | user msgs visible: ${userMsgs}`);

    // Screenshots
    if ([10, 20, 40, 60, 90].includes(elapsed)) {
      await page.screenshot({ path: `/tmp/ai-chat-debug-${elapsed}s.png` });
      console.log(`   Screenshot: /tmp/ai-chat-debug-${elapsed}s.png`);
    }

    // If after 30s still nothing, dump a snippet of the page text
    if (elapsed === 30) {
      console.log(`   Page text snippet: "${bodyText.substring(0, 300)}"`);
    }
  }

  await page.screenshot({ path: '/tmp/ai-chat-debug-final.png' });
  console.log('\nFinal screenshot: /tmp/ai-chat-debug-final.png');

  await browser.close();
}

main().catch(console.error);
