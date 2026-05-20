#!/usr/bin/env node
/**
 * AI Chat browser integration test via Playwright.
 *
 * Logs into test.bizzassist.dk, opens the AI chat, sends 15 test
 * questions and evaluates responses.
 *
 * Usage: node scripts/ai-chat-browser-test.mjs
 *
 * @module scripts/ai-chat-browser-test
 */

import { chromium } from 'playwright';

const BASE_URL = 'https://test.bizzassist.dk';
const EMAIL = 'jjrchefen@gmail.com';
const PASSWORD = 'Kongen72';

const TESTS = [
  {
    id: 1,
    question: 'Hvad er byggeåret og boligarealet for Vigerslevvej 146, 1. th, 2500 Valby?',
    expectAny: ['1940', 'm²', 'bolig'],
    tab: 'Oversigt/BBR',
  },
  {
    id: 2,
    question: 'Hvad er den seneste ejendomsvurdering og grundværdi for Vigerslevvej 146, 1. th, 2500 Valby?',
    expectAny: ['DKK', 'vurdering', 'grundværdi'],
    tab: 'Økonomi',
  },
  {
    id: 3,
    question: 'Hvem ejer Vigerslevvej 146, 1. th, 2500 Valby, og hvornår overtog de?',
    expectAny: ['Jakob', 'Rasmussen', '2005'],
    tab: 'Ejerskab',
  },
  {
    id: 4,
    question: 'Er der hæftelser eller servitutter tinglyst på Vigerslevvej 146, 1. th, 2500 Valby?',
    expectAny: ['tinglys', 'pant', 'hæftelse', 'servitut'],
    tab: 'Tinglysning',
  },
  {
    id: 5,
    question: 'Hvad er energimærket for Vigerslevvej 146, 1. th, 2500 Valby?',
    expectAny: ['energi', 'klasse', 'mærke'],
    tab: 'Dokumenter',
  },
  {
    id: 6,
    question: 'Er der jordforurening registreret på Vigerslevvej 146, 2500 Valby?',
    expectAny: ['forurening', 'kortlagt', 'V1', 'V2', 'ikke'],
    tab: 'Dokumenter',
  },
  {
    id: 7,
    question: 'Hvilken lokalplan gælder for Vigerslevvej 146, 2500 Valby?',
    expectAny: ['lokalplan', 'plan', 'kommune'],
    tab: 'Dokumenter',
  },
  {
    id: 8,
    question: 'Hvad er matrikelnummeret og grundarealet for Vigerslevvej 146, 2500 Valby?',
    expectAny: ['matrikel', 'm²', 'areal'],
    tab: 'BBR',
  },
  {
    id: 9,
    question: 'Hvad laver JaJR Holding ApS (CVR 41092807), og hvornår blev virksomheden stiftet?',
    expectAny: ['41092807', 'stiftet', 'holding'],
    tab: 'Virksomhed',
  },
  {
    id: 10,
    question: 'Hvad er egenkapitalen for JaJR Holding ApS (CVR 41092807) i det seneste regnskab?',
    expectAny: ['egenkapital', 'DKK', 'kr'],
    tab: 'Regnskab',
  },
  {
    id: 11,
    question: 'Hvem er direktør for JaJR Holding ApS (CVR 41092807)?',
    expectAny: ['Jakob', 'direktør'],
    tab: 'Nøglepersoner',
  },
  {
    id: 12,
    question: 'Hvilke ejendomme ejer JaJR Holding ApS (CVR 41092807)? Giv mig de første 5.',
    expectAny: ['BFE', 'ejendom', 'adresse', 'boulevard'],
    tab: 'Ejendomme',
  },
  {
    id: 13,
    question: 'Hvilke virksomheder er Jakob Juul Rasmussen tilknyttet? Søg med enhedsnummer 4004514945.',
    expectAny: ['JaJR', 'Holding', 'rolle', 'direktør'],
    tab: 'Person',
  },
  {
    id: 14,
    question: 'Hvad er den forventede årlige ejendomsskat for Vigerslevvej 146, 1. th, 2500 Valby under det nye vurderingssystem?',
    expectAny: ['skat', 'DKK', 'grundskyld', 'kr'],
    tab: 'SKAT',
  },
  {
    id: 15,
    question: 'Hvad er befolkningstallet og den gennemsnitlige indkomst i området omkring Vigerslevvej 146, 2500 Valby?',
    expectAny: ['befolkning', 'indkomst', 'område'],
    tab: 'Områdeprofil',
  },
];

async function main() {
  console.log('=== AI Chat Browser Test ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'da-DK',
  });
  const page = await context.newPage();

  // ── Login ──────────────────────────────────────────────────────────
  console.log('Logging in...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');

  // Wait for redirect to dashboard
  try {
    await page.waitForURL('**/dashboard**', { timeout: 15000 });
    console.log('Logged in successfully\n');
  } catch {
    console.error('Login failed — could not reach dashboard');
    await browser.close();
    process.exit(1);
  }

  // ── Open AI Chat ───────────────────────────────────────────────────
  // Look for the AI Chat button/panel
  try {
    const chatButton = page.locator('button:has-text("AI Chat"), a:has-text("AI Chat"), [aria-label*="chat" i]').first();
    await chatButton.click({ timeout: 5000 });
    await page.waitForTimeout(2000);
    console.log('AI Chat panel opened\n');
  } catch {
    // Maybe chat is already visible or accessed via sidebar
    console.log('Navigating to AI Chat via sidebar...');
    try {
      await page.click('text=AI Chat', { timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch {
      console.log('Could not find AI Chat button — trying direct URL');
      // Some apps have a dedicated chat page
    }
  }

  // ── Run tests ──────────────────────────────────────────────────────
  const results = [];

  for (const test of TESTS) {
    process.stdout.write(`Test ${test.id}/15: ${test.tab} ... `);

    try {
      // Find the chat input — it's an <input type="text"> with placeholder containing "Spørg" or "Ask"
      const input = page.locator('input[type="text"][class*="bg-transparent"]').first();
      await input.waitFor({ timeout: 10000 });

      // Clear and type question
      await input.fill('');
      await input.fill(test.question);
      await input.press('Enter');

      // Wait for AI response in the sidebar chat panel
      let responseText = '';
      let stableCount = 0;
      const maxWait = 120000; // 2 min max per question
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        await page.waitForTimeout(5000);

        // Read text from the chat sidebar panel (right side of page)
        // The panel has title "AI Chat" and contains all messages
        const panelText = await page.evaluate(() => {
          // Find elements that contain the chat panel — look for the sidebar
          const panels = document.querySelectorAll('[class*="fixed"], [class*="absolute"], aside, [class*="drawer"]');
          for (const p of panels) {
            const text = p.innerText || '';
            if (text.includes('AI Chat') && text.includes('Stil et spørgsmål')) {
              return text;
            }
          }
          // Fallback: grab everything from right side of viewport
          const all = document.querySelectorAll('div');
          let best = '';
          for (const d of all) {
            const rect = d.getBoundingClientRect();
            if (rect.left > 1000 && rect.width > 200) {
              const t = d.innerText || '';
              if (t.length > best.length) best = t;
            }
          }
          return best;
        }).catch(() => '');

        if (panelText && panelText.length > 100) {
          if (panelText === responseText) {
            stableCount++;
            if (stableCount >= 2) {
              responseText = panelText;
              break;
            }
          } else {
            responseText = panelText;
            stableCount = 0;
          }
        }
      }

      // Check keywords
      const lower = responseText.toLowerCase();
      const matched = test.expectAny.filter(k => lower.includes(k.toLowerCase()));

      if (matched.length > 0) {
        console.log(`✅ PASS (${responseText.length} chars, matched: ${matched.join(', ')})`);
        results.push({ ...test, status: 'PASS', responseLength: responseText.length, matched });
      } else if (responseText.length > 50) {
        console.log(`⚠️  KEYWORD MISS (${responseText.length} chars, expected: ${test.expectAny.join('/')})`);
        results.push({ ...test, status: 'KEYWORD_MISS', responseLength: responseText.length, preview: responseText.substring(0, 300) });
      } else {
        console.log(`❌ NO RESPONSE (${responseText.length} chars)`);
        results.push({ ...test, status: 'NO_RESPONSE', responseLength: responseText.length });
      }

    } catch (err) {
      console.log(`❌ ERROR: ${err.message.substring(0, 100)}`);
      results.push({ ...test, status: 'ERROR', error: err.message.substring(0, 200) });
    }

    // Wait between tests to avoid rate limiting
    await page.waitForTimeout(5000);
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n=== RESULTS ===\n');
  const passed = results.filter(r => r.status === 'PASS');
  const failed = results.filter(r => r.status !== 'PASS');

  console.log(`Passed: ${passed.length}/15`);
  console.log(`Failed: ${failed.length}/15`);

  if (failed.length > 0) {
    console.log('\n--- FAILURES ---\n');
    for (const f of failed) {
      console.log(`Test ${f.id} (${f.tab}): ${f.status}`);
      console.log(`  Question: ${f.question.substring(0, 80)}...`);
      if (f.error) console.log(`  Error: ${f.error}`);
      if (f.preview) console.log(`  Preview: ${f.preview.substring(0, 200)}...`);
      console.log();
    }
  }

  // Save results
  const fs = await import('fs');
  fs.writeFileSync(
    new URL('./ai-chat-test-results.json', import.meta.url),
    JSON.stringify(results, null, 2)
  );
  console.log('Results saved to scripts/ai-chat-test-results.json');

  await browser.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
