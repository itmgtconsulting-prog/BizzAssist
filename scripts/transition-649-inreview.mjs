#!/usr/bin/env node
/**
 * BIZZ-649 blev genåbnet: den oprindelige gate var kun wired til /api/ai/chat.
 * De 7 øvrige AI-endpoints (article-search, person-article-search,
 * person-search/{socials,contacts,articles}, analysis/run, support/chat)
 * kaldte Anthropic uden nogen gate-check.
 *
 * Commit 84633f7 introducerer central helper `assertAiAllowed()` i
 * `app/lib/aiGate.ts` og wirer den ind i alle 8 endpoints.
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
    h(2, 'Code-level verifikation — FIX implementeret (commit 84633f7)'),
    p(
      strong('Root cause: '),
      txt(
        'Den oprindelige gate var kun kaldt fra '
      ),
      code('/api/ai/chat'),
      txt(
        '. 7 andre Anthropic-ramte endpoints bypassede quota-checket helt, så en trial-bruger (eller ethvert scenarie med plan=0 + bonus=0 + topUp=0) kunne kalde Anthropic via dem uden at blive blokeret.'
      )
    ),
    h(3, 'Implementering'),
    ul(
      li(
        p(
          strong('Ny helper: '),
          code('app/lib/aiGate.ts'),
          txt(' eksporterer '),
          code('assertAiAllowed(userId)'),
          txt(
            ' som returnerer null hvis tilladt, ellers Response (401/403/429/402). Delegerer til eksisterende '
          ),
          code('decideAiGate()'),
          txt(' for at undgå divergens i beslutnings-træet.')
        )
      ),
      li(
        p(
          strong('Policy 1 — admin bypass: '),
          txt('brugere med '),
          code('app_metadata.isAdmin === true'),
          txt(' bypasser gate uden subscription-check.')
        )
      ),
      li(
        p(
          strong('Policy 2 — -1 unlimited: '),
          code('plan_configs.ai_tokens_per_month === -1'),
          txt(' returnerer allow (enterprise-konvention dokumenteret i '),
          code('subscriptions.ts:55'),
          txt(' + '),
          code('AIChatPanel.tsx:319'),
          txt(').')
        )
      ),
      li(
        p(
          strong('Policy 3 — zero_budget: '),
          txt('Sentry-breadcrumb før 402-respons så forsøg kan audites i produktion.')
        )
      )
    ),
    h(3, 'Endpoints der nu er gated'),
    ul(
      li(p(code('/api/ai/chat'), txt(' (refactored til at bruge shared helper)'))),
      li(p(code('/api/ai/article-search'))),
      li(p(code('/api/ai/person-article-search'))),
      li(p(code('/api/ai/person-search/socials'))),
      li(p(code('/api/ai/person-search/contacts'))),
      li(p(code('/api/ai/person-search/articles'))),
      li(p(code('/api/analysis/run'))),
      li(p(code('/api/support/chat')))
    ),
    h(3, 'Tests'),
    ul(
      li(
        p(
          code('__tests__/unit/aiGate.test.ts'),
          txt(' — 10 tests: admin-bypass, -1 unlimited, getUserById-fejl, zero_budget (trial + active), quota_exceeded, no_subscription, topUp-tillader-trial.')
        )
      ),
      li(
        p(
          code('__tests__/unit/decideAiGate.test.ts'),
          txt(' — 11 tests (uændret, ren decision-logik).')
        )
      ),
      li(p(strong('Resultat: '), code('npm test'), txt(' → 1504 passed (93 filer).'))),
      li(p(strong('Type-check: '), code('npx tsc --noEmit'), txt(' → 0 errors.')))
    ),
    h(3, 'Verifikation'),
    p(
      txt('Pushed til '),
      code('develop'),
      txt(' (commit '),
      code('84633f7'),
      txt('). Klar til deploy — browser-verifikation på '),
      code('test.bizzassist.dk'),
      txt(' når Vercel-preview er grøn.')
    ),
    p(strong('Transitioner til In Review for browser-verifikation.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-649/comment', { body });
console.log(c.status === 201 ? '✅ comment posted' : `❌ (${c.status}) ${c.body}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-649/transitions');
const transitions = JSON.parse(tr.body).transitions || [];
console.log('available:', transitions.map((t) => t.name).join(', '));
const inReview = transitions.find((t) => /in review/i.test(t.name));
if (!inReview) {
  console.log('⚠️ "In Review" transition not available');
  process.exit(1);
}
const r = await req('POST', '/rest/api/3/issue/BIZZ-649/transitions', {
  transition: { id: inReview.id },
});
console.log(r.status === 204 ? '✅ BIZZ-649 → In Review' : `⚠️ (${r.status}) ${r.body}`);
