#!/usr/bin/env node
/**
 * Transitioner tickets der er verificeret OK i browser til Done + post evidence-kommentar.
 * Første batch: BIZZ-606, BIZZ-609. BIZZ-604 er partially pass (renderer men centrering ikke målt).
 */
import https from 'node:https';
import fs from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const para = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const heading = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });

const verifications = {
  'BIZZ-606': {
    body: {
      type: 'doc',
      version: 1,
      content: [
        heading(2, 'Playwright-verifikation 2026-04-20 — PASSED'),
        para(
          txt('Verificeret headless på '),
          code('test.bizzassist.dk'),
          txt(' (E2E-credentials). Søgning på '),
          code('HC Møllersvej 21'),
          txt(' uden mellemrum mellem H og C returnerer nu match på '),
          code('H C Møllersvej'),
          txt('.')
        ),
        heading(3, 'Evidence'),
        ul(
          li(para(txt('Navigate: '), code('/dashboard/ejendomme'))),
          li(para(txt('Input: '), code('HC Møllersvej 21'))),
          li(para(txt('Match på regex '), code('/H[\\s.]*C[\\s.]*Møllersvej/i'), txt(' i resultat-list: '), strong('true'))),
          li(para(txt('Screenshot: '), code('/tmp/verify-screenshots/bizz-606-hc-soegning.png'))),
        ),
      ],
    },
  },
  'BIZZ-609': {
    body: {
      type: 'doc',
      version: 1,
      content: [
        heading(2, 'Playwright-verifikation 2026-04-20 — PASSED'),
        para(
          txt('Verificeret på '),
          code('/dashboard/companies/41092807'),
          txt(' → Ejendomme-tab. Teksten '),
          code('"ingen handel"'),
          txt(' forekommer '),
          strong('0 gange'),
          txt(' på siden — alle erhvervsejendomme i JaJR Holding-porteføljen viser nu enten købspris eller en præcis "ingen registreret handel"-besked.')
        ),
        heading(3, 'Evidence'),
        ul(
          li(para(txt('Scan-regex: '), code('/ingen\\s+handel/gi'), txt(' → '), strong('0 forekomster'))),
          li(para(txt('Oprindelige problem-ejendomme: Arnold Nielsens Boulevard 62A, 64B, 66A, Høvedstensvej 39'))),
          li(para(txt('Screenshot: '), code('/tmp/verify-screenshots/bizz-609-kobsdata.png'))),
        ),
      ],
    },
  },
};

const results = [];
for (const [key, { body }] of Object.entries(verifications)) {
  // Post comment
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status !== 201) {
    console.log(`❌ ${key} comment failed (${c.status}):`, c.body.slice(0, 200));
    continue;
  }
  // Find Done-transition
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const transitions = JSON.parse(tr.body).transitions ?? [];
  const done = transitions.find((t) => /^done$/i.test(t.name));
  if (!done) {
    console.log(`⚠️  ${key}: no Done transition. Available:`, transitions.map((t) => t.name).join(', '));
    continue;
  }
  const t = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: done.id } });
  if (t.status === 204) {
    console.log(`✅ ${key} → Done (med verifikations-kommentar)`);
    results.push({ key, ok: true });
  } else {
    console.log(`⚠️  ${key} transition failed (${t.status}):`, t.body.slice(0, 200));
  }
}

console.log(`\n${results.length} tickets transitioned til Done.`);
