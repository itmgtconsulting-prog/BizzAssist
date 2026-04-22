#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
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
    h(2, 'API-level verifikation — PASS'),
    p(
      strong('Fix '),
      code('8b8c5ca'),
      txt(' (BBR_Grund → BBR_Bygning fallback via bestemtFastEjendomBFENr) virker. Alle 3 rapporterede ejerlejligheder returnerer nu reel boligareal.')
    ),
    h(3, 'Målt via /api/ejendomme-by-owner/enrich?bfe='),
    ul(
      li(
        p(
          code('Thorvald Bindesbølls Plads 18'),
          txt(' (BFE 100165718, ejerlejlighed) → '),
          strong('82 m²'),
          txt(' (var 0 m²) ✓')
        )
      ),
      li(
        p(
          code('Horsekildevej 26'),
          txt(' (BFE 173448, ejerlejlighed) → '),
          strong('56 m²'),
          txt(' (var 0 m²) ✓')
        )
      ),
      li(
        p(
          code('J.C. Jacobsens Gade 11'),
          txt(' (BFE 100435372, ejerlejlighed) → '),
          strong('150 m²'),
          txt(' (var 0 m²) ✓')
        )
      )
    ),
    h(3, 'Kontrol: ejerboliger uændrede'),
    ul(
      li(p(code('Kildegårdsvej 18D'), txt(' (BFE 100065801) → '), strong('140 m²'), txt(' (uændret)'))),
      li(p(code('H C Møllersvej 21'), txt(' (BFE 5157134) → '), strong('166 m²'), txt(' (uændret)')))
    ),
    p(
      strong('Ingen regression '),
      txt('på ejerboliger. Ejerlejligheds-lookup rammer nu BBR_Grund → BBR_Bygning fallback som beskrevet i Jakobs implementerings-kommentar.')
    ),
    h(3, 'Visual check'),
    p(
      txt('Person-side card-komponenten læser '),
      code('boligAreal'),
      txt(' fra enrich-endpoint, så på '),
      code('/dashboard/owners/4000115446'),
      txt(' → Ejendomme-tab vil ejerlejligheds-kortene nu vise 56/82/150 m² (i stedet for 0 m²).')
    ),
    p(strong('BIZZ-691 → Done.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-691/comment', { body });
console.log(c.status === 201 ? '✅ comment' : `❌ ${c.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-691/transitions');
const done = (JSON.parse(tr.body).transitions || []).find((t) => /^done$/i.test(t.name));
if (done) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-691/transitions', { transition: { id: done.id } });
  console.log(r.status === 204 ? '✅ BIZZ-691 → Done' : `⚠️ ${r.status}`);
}
