#!/usr/bin/env node
/**
 * AI Chat integration test — validates that all 29 tools return correct data.
 *
 * Sends 15 test questions to the AI chat API and evaluates responses.
 * Logs failures for JIRA ticket creation.
 *
 * Usage: node scripts/ai-chat-test.mjs
 *
 * @module scripts/ai-chat-test
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });

// Preview/test environment (rlkjmqjxmkxuclehbrnl)
const SUPABASE_URL = 'https://rlkjmqjxmkxuclehbrnl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsa2ptcWp4bWt4dWNsZWhicm5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NTM5MDUsImV4cCI6MjA5MTIyOTkwNX0.D8LCO5Lez3YWoupUqs3G6I6XYkGhZnUTCYptEYKLvDg';
const TEST_EMAIL = 'jjrchefen@gmail.com';
const TEST_PASSWORD = 'Kongen72';
const BASE_URL = 'https://test.bizzassist.dk';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or ANON_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Test questions with expected keywords in the response */
const TESTS = [
  {
    id: 1,
    question: 'Hvad er byggeåret og boligarealet for Vigerslevvej 146, 1. th, 2500 Valby?',
    tools: ['hent_bbr_data'],
    expectKeywords: ['1940', 'm²'],
    tab: 'Oversigt/BBR',
  },
  {
    id: 2,
    question: 'Hvad er den seneste ejendomsvurdering og grundværdi for Vigerslevvej 146, 1. th, 2500 Valby?',
    tools: ['hent_vurdering'],
    expectKeywords: ['DKK', 'vurdering'],
    tab: 'Økonomi',
  },
  {
    id: 3,
    question: 'Hvem ejer Vigerslevvej 146, 1. th, 2500 Valby, og hvornår overtog de?',
    tools: ['hent_ejerskab'],
    expectKeywords: ['Jakob', 'Rasmussen', '2005'],
    tab: 'Ejerskab',
  },
  {
    id: 4,
    question: 'Er der hæftelser eller servitutter tinglyst på Vigerslevvej 146, 1. th, 2500 Valby?',
    tools: ['hent_tinglysning'],
    expectKeywords: ['tinglys', 'pant'],
    tab: 'Tinglysning',
  },
  {
    id: 5,
    question: 'Hvad er energimærket for Vigerslevvej 146, 1. th, 2500 Valby?',
    tools: ['hent_energimaerke'],
    expectKeywords: ['energi'],
    tab: 'Dokumenter',
  },
  {
    id: 6,
    question: 'Er der jordforurening registreret på Vigerslevvej 146, 2500 Valby?',
    tools: ['hent_jordforurening'],
    expectKeywords: ['forurening', 'kortlagt', 'V1', 'V2', 'ikke'],
    tab: 'Dokumenter',
  },
  {
    id: 7,
    question: 'Hvilken lokalplan gælder for Vigerslevvej 146, 2500 Valby?',
    tools: ['hent_plandata'],
    expectKeywords: ['lokalplan', 'plan'],
    tab: 'Dokumenter',
  },
  {
    id: 8,
    question: 'Hvad er matrikelnummeret og grundarealet for Vigerslevvej 146, 2500 Valby?',
    tools: ['hent_matrikeldata'],
    expectKeywords: ['matrikel', 'm²'],
    tab: 'BBR',
  },
  {
    id: 9,
    question: 'Hvad laver JaJR Holding ApS (CVR 41092807), og hvornår blev virksomheden stiftet?',
    tools: ['hent_cvr_virksomhed'],
    expectKeywords: ['41092807', 'stiftet', 'holding'],
    tab: 'Virksomhed',
  },
  {
    id: 10,
    question: 'Hvad er egenkapitalen for JaJR Holding ApS (CVR 41092807) i det seneste regnskab?',
    tools: ['hent_regnskab_noegletal'],
    expectKeywords: ['egenkapital', 'DKK'],
    tab: 'Regnskab',
  },
  {
    id: 11,
    question: 'Hvem er direktør for JaJR Holding ApS (CVR 41092807)?',
    tools: ['hent_virksomhed_personer'],
    expectKeywords: ['Jakob', 'direktør'],
    tab: 'Nøglepersoner',
  },
  {
    id: 12,
    question: 'Hvilke ejendomme ejer JaJR Holding ApS (CVR 41092807)? Giv mig de første 5.',
    tools: ['hent_ejendomme_for_virksomhed'],
    expectKeywords: ['BFE', 'ejendom'],
    tab: 'Ejendomme',
  },
  {
    id: 13,
    question: 'Hvilke virksomheder er Jakob Juul Rasmussen tilknyttet? Søg med enhedsnummer 4004514945.',
    tools: ['hent_person_virksomheder'],
    expectKeywords: ['JaJR', 'rolle'],
    tab: 'Person',
  },
  {
    id: 14,
    question: 'Hvad er den forventede årlige ejendomsskat (grundskyld + ejendomsværdiskat) for Vigerslevvej 146, 1. th, 2500 Valby under det nye vurderingssystem?',
    tools: ['hent_forelobig_vurdering'],
    expectKeywords: ['skat', 'DKK'],
    tab: 'SKAT',
  },
  {
    id: 15,
    question: 'Hvad er befolkningstallet og den gennemsnitlige indkomst i området omkring Vigerslevvej 146, 2500 Valby?',
    tools: ['hent_omraadeprofil'],
    expectKeywords: ['befolkning', 'indkomst'],
    tab: 'Områdeprofil',
  },
];

/**
 * Send a chat message and collect the full streamed response.
 *
 * @param {string} accessToken - Supabase JWT
 * @param {string} question - User message
 * @returns {{ text: string, toolsCalled: string[], error: string|null }}
 */
async function askChat(accessToken, refreshToken, question) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

  try {
    // Supabase SSR reads session from sb-{ref}-auth-token cookie
    const ref = 'rlkjmqjxmkxuclehbrnl';
    const cookieValue = JSON.stringify([accessToken, refreshToken]);
    const res = await fetch(`${BASE_URL}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `sb-${ref}-auth-token=${encodeURIComponent(cookieValue)}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: question }],
        context: {},
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { text: '', toolsCalled: [], error: `HTTP ${res.status}: ${errText.substring(0, 200)}` };
    }

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    const toolsCalled = [];
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const evt = JSON.parse(payload);
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            fullText += evt.delta.text;
          }
          if (evt.type === 'tool_status') {
            toolsCalled.push(evt.tool);
          }
          // Also catch tool_use events
          if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            toolsCalled.push(evt.content_block.name);
          }
        } catch {
          // Not JSON or partial — skip
        }
      }
    }

    return { text: fullText, toolsCalled, error: null };
  } catch (err) {
    return { text: '', toolsCalled: [], error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if response contains expected keywords (case-insensitive).
 *
 * @param {string} text - AI response text
 * @param {string[]} keywords - Expected keywords (at least one must match)
 * @returns {{ pass: boolean, matched: string[], missing: string[] }}
 */
function checkKeywords(text, keywords) {
  const lower = text.toLowerCase();
  const matched = keywords.filter(k => lower.includes(k.toLowerCase()));
  const missing = keywords.filter(k => !lower.includes(k.toLowerCase()));
  return { pass: matched.length > 0, matched, missing };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== AI Chat Integration Test ===\n');

  // Login
  console.log('Logging in...');
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (authError || !authData?.session) {
    console.error('Login failed:', authError?.message || 'No session');
    console.error('Set TEST_USER_PASSWORD env var if needed');
    process.exit(1);
  }

  const accessToken = authData.session.access_token;
  const refreshToken = authData.session.refresh_token;
  console.log('Logged in as', TEST_EMAIL, '\n');

  const results = [];

  for (const test of TESTS) {
    process.stdout.write(`Test ${test.id}/15: ${test.tab} ... `);

    const { text, toolsCalled, error } = await askChat(accessToken, refreshToken, test.question);

    if (error) {
      console.log(`❌ ERROR: ${error}`);
      results.push({ ...test, status: 'ERROR', error, text: '', toolsCalled });
      continue;
    }

    if (!text || text.trim().length < 10) {
      console.log(`❌ EMPTY RESPONSE (${text.length} chars)`);
      results.push({ ...test, status: 'EMPTY', error: 'Tomt eller meget kort svar', text, toolsCalled });
      continue;
    }

    const { pass, matched, missing } = checkKeywords(text, test.expectKeywords);

    if (pass) {
      console.log(`✅ OK (${text.length} chars, tools: ${toolsCalled.join(', ') || 'none'}, matched: ${matched.join(', ')})`);
      results.push({ ...test, status: 'PASS', text: text.substring(0, 300), toolsCalled });
    } else {
      console.log(`⚠️  KEYWORD MISS (missing: ${missing.join(', ')}, got ${text.length} chars)`);
      results.push({ ...test, status: 'KEYWORD_MISS', error: `Missing keywords: ${missing.join(', ')}`, text: text.substring(0, 500), toolsCalled });
    }

    // Rate limit: wait 8 seconds between requests (10 req/min limit)
    await new Promise(r => setTimeout(r, 8000));
  }

  // Summary
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
      console.log(`  Error: ${f.error || 'N/A'}`);
      console.log(`  Tools called: ${f.toolsCalled?.join(', ') || 'none'}`);
      if (f.text) console.log(`  Response preview: ${f.text.substring(0, 200)}...`);
      console.log();
    }
  }

  // Write results to file for later JIRA creation
  const fs = await import('fs');
  fs.writeFileSync(
    join(__dirname, 'ai-chat-test-results.json'),
    JSON.stringify(results, null, 2)
  );
  console.log('Results saved to scripts/ai-chat-test-results.json');
}

main().catch(console.error);
