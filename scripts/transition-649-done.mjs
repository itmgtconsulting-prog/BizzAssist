#!/usr/bin/env node
/**
 * BIZZ-649 final: Playwright-verifikation PASS på test.bizzassist.dk.
 * Alle 10 Anthropic-ramte endpoints blokerer korrekt for zero-budget bruger.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString(
  'base64'
);
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method: m,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
        },
      },
      (x) => {
        let y = '';
        x.on('data', (c) => (y += c));
        x.on('end', () => res({ status: x.statusCode, body: y }));
      }
    );
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const body = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'Playwright-verifikation — PASS (live på test.bizzassist.dk)'),
    p(
      strong('Test-bruger: '),
      code('jjrchefen@gmail.com'),
      txt(
        ' — testplan1 (ai_tokens_per_month=0), status=active, bonusTokens=0, topUpTokens=0, tokensUsedThisMonth=0, isAdmin=null. Dvs. exact zero-budget scenariet BIZZ-649 beskriver.'
      )
    ),
    h(3, 'Resultat — alle 10 endpoints returnerer 402 trial_ai_blocked'),
    ul(
      li(p(code('/api/ai/chat'), txt(' → 402 trial_ai_blocked ✓'))),
      li(p(code('/api/ai/article-search'), txt(' → 402 trial_ai_blocked ✓'))),
      li(p(code('/api/ai/article-search/articles?phase=ai'), txt(' → 402 trial_ai_blocked ✓'))),
      li(p(code('/api/ai/article-search/socials'), txt(' → 402 trial_ai_blocked ✓'))),
      li(p(code('/api/ai/person-article-search'), txt(' → 402 trial_ai_blocked ✓'))),
      li(p(code('/api/ai/person-search/socials'), txt(' → 402 trial_ai_blocked ✓'))),
      li(p(code('/api/ai/person-search/contacts'), txt(' → 402 trial_ai_blocked ✓'))),
      li(p(code('/api/ai/person-search/articles'), txt(' → 402 trial_ai_blocked ✓'))),
      li(p(code('/api/analysis/run'), txt(' → 402 trial_ai_blocked ✓'))),
      li(p(code('/api/support/chat'), txt(' → 402 trial_ai_blocked ✓')))
    ),
    h(3, 'Historisk fix-sti'),
    ul(
      li(
        p(
          code('84633f7'),
          txt(': introducér '),
          code('app/lib/aiGate.ts#assertAiAllowed'),
          txt(' + wire into 8 endpoints (chat + 7 bypassing).')
        )
      ),
      li(
        p(
          code('c4f409c'),
          txt(': scrub env-var-name leak (ISO 27001) — alle 10 endpoints returnerer nu generisk besked + '),
          code('code: ai_unavailable'),
          txt(' for uniform buy-tokens-banner i UI.')
        )
      ),
      li(
        p(
          code('ef908c0'),
          txt(': wire gate ind i de to sub-routes under '),
          code('/article-search/'),
          txt(' (articles + socials) som originalt fix missede.')
        )
      )
    ),
    h(3, 'Ops-rettelse samtidig'),
    p(
      code('BIZZASSIST_CLAUDE_KEY'),
      txt(' var kun sat på '),
      code('production'),
      txt(' target i Vercel — kopieret til '),
      code('preview'),
      txt(' + '),
      code('development'),
      txt(' så test.bizzassist.dk faktisk kan kalde Anthropic når gate tillader det.')
    ),
    h(3, 'Test-dækning'),
    ul(
      li(p(code('__tests__/unit/decideAiGate.test.ts'), txt(' — 11 tests, grønne'))),
      li(p(code('__tests__/unit/aiGate.test.ts'), txt(' — 10 tests (admin-bypass, -1 unlimited, zero_budget, quota_exceeded, no_subscription, topUp-trial, 401/403)'))),
      li(p(strong('Total: '), code('npm test'), txt(' → 1504/1504 passed.')))
    ),
    p(strong('Billing-lækage lukket.'), txt(' BIZZ-649 → Done.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-649/comment', { body });
console.log(c.status === 201 ? '✅ comment posted' : `❌ (${c.status}) ${c.body}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-649/transitions');
const transitions = JSON.parse(tr.body).transitions || [];
const done = transitions.find((t) => /^done$/i.test(t.name));
if (!done) {
  console.log('⚠️ "Done" transition not available');
  process.exit(1);
}
const r = await req('POST', '/rest/api/3/issue/BIZZ-649/transitions', {
  transition: { id: done.id },
});
console.log(r.status === 204 ? '✅ BIZZ-649 → Done' : `⚠️ (${r.status}) ${r.body}`);
