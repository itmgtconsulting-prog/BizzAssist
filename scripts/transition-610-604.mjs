#!/usr/bin/env node
/**
 * Transitionerer BIZZ-610 + BIZZ-604 til Done baseret på screenshot-review.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}

const para = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => marks ? { type: 'text', text, marks } : { type: 'text', text };
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });

const bodies = {
  'BIZZ-610': {
    type: 'doc', version: 1, content: [
      h(2, 'Playwright-verifikation 2026-04-20 — PASSED'),
      para(txt('Verificeret på '), code('/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465'), txt(' → Ejerskab-tab.')),
      h(3, 'Resultat'),
      ul(
        li(para(txt('Ejerskab-tab viser '), strong('kun'), txt(' JAJR Ejendomme ApS (CVR 26316804) med 100% ejerandel, overtaget 14. april 2023.'))),
        li(para(txt('Historiske ejere Sarah Boutrup Funch, Anders Boutrup Funch og CVR 35658912 er '), strong('ikke længere'), txt(' synlige.'))),
        li(para(txt('Ejerskabs-diagrammet nederst viser korrekt kæde: Jakob/David/Silas/Felix → holdingselskaber → JaJR Ejendomme 2 → JAJR Ejendomme ApS → Kaffevej 31.'))),
        li(para(txt('Sum af ejerandele = 100% (ikke 300%).'))),
      ),
      h(3, 'Evidence'),
      ul(li(para(txt('Screenshot: '), code('/tmp/verify-screenshots/bizz-610-v2-after-tab.png')))),
    ],
  },
  'BIZZ-604': {
    type: 'doc', version: 1, content: [
      h(2, 'Playwright-verifikation 2026-04-20 — PASSED'),
      para(txt('Verificeret på '), code('/dashboard/ejendomme/dd4a90de-b126-4438-824f-3677efab2bd0'), txt(' (Thorvald Bindesbølls Plads 18, 3. th) → Ejerskab-tab.')),
      h(3, 'Resultat'),
      ul(
        li(para(txt('Ejerskabsdiagrammet renderes '), strong('centreret'), txt(' i diagrampanelet — både Jakob Juul Rasmussen-noden (top) og ejendomsnoden (bund) er horisontalt centreret.'))),
        li(para(txt('100%-label vises korrekt på forbindelseslinjen mellem person og ejendom.'))),
        li(para(txt('Ingen venstrestilling / unødig tom plads på højre side som tidligere rapporteret.'))),
      ),
      h(3, 'Evidence'),
      ul(li(para(txt('Screenshot: '), code('/tmp/verify-screenshots/bizz-604-v2-ejerskab.png')))),
    ],
  },
};

for (const [key, body] of Object.entries(bodies)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status !== 201) { console.log(`❌ ${key} comment failed: ${c.status}`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const done = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
  if (!done) { console.log(`⚠️ ${key}: no Done transition`); continue; }
  const t = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: done.id } });
  console.log(t.status === 204 ? `✅ ${key} → Done` : `⚠️ ${key} transition ${t.status}`);
}
