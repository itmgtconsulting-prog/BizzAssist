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
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

const body = doc(
  h(2, 'Code-review + API-verifikation — PASS'),
  h(3, 'API-response for BFE 2091165 (Arnold Nielsens Boulevard 62C)'),
  cb(
`GET /api/ejerskab/chain?bfe=2091165
{
  "nodes":[
    {"id":"bfe-2091165","label":"Ejendom","type":"property"},
    {"id":"status-1","label":"Opdelt i anpart 1-2","type":"status"}  ✅
  ],
  "ejerDetaljer":[{
    "navn":"Opdelt i anpart 1-2",
    "cvr":null,
    "enhedsNummer":null,       ✅ (tidligere 4004206010 = forkert CVR-kollision)
    "type":"status",           ✅ (tidligere "person")
    "adkomstType":null
  }]
}`,
    'json'
  ),
  p(txt('Fejlklassifikation fikset: "Opdelt i anpart 1-2" rendres som status i stedet for privatperson. Intet '), code('enhedsNummer'), txt(' genereres, så ingen navigation til den urelaterede revisionsvirksomhed.')),

  h(3, 'Kode-verifikation'),
  ul(
    li(p(code('app/api/ejerskab/chain/route.ts:73-74'), txt(': '), code('STATUS_TEKST_RE = /^\\s*(opdelt i (ejerlejlighed(er)?|(ideel(le)? )?anpart(er)?)|del af samlet ejendom)\\b/i'), txt('.'))),
    li(p(txt('Dækker alle varianter: "Opdelt i anpart", "Opdelt i anparter", "Opdelt i ideel anpart", "Opdelt i ideelle anparter", "Opdelt i ejerlejlighed(er)", "del af samlet ejendom".'))),
    li(p(code('__tests__/unit/ejerskab-status-tekst.test.ts'), txt(' — 7 unit-tests bekræftet ('), code('grep -c'), txt(' → 7).'))),
  ),

  h(3, 'Follow-up (noteret af Jakob, ikke dækket her)'),
  ul(
    li(p(txt('Administrator-selskab (ArnBo 62 ApS) som primær ejer-node i diagrammet.'))),
    li(p(txt('Audit af '), code('/api/owners/4004206010'), txt('-lookup-kollision til revisionsvirksomhed (separat datalinking-bug).'))),
  ),
  p(txt('Begge er out of scope for denne ticket. Hvis de skal trackes: opret follow-up-ticket.')),

  p(strong('Commit: '), code('8b69186'), txt('. → Done.'))
);

const cr = await req('POST', '/rest/api/3/issue/BIZZ-726/comment', { body });
console.log(cr.status === 201 ? '✅ BIZZ-726 comment posted' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-726/transitions');
const done = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
if (done) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-726/transitions', { transition: { id: done.id } });
  console.log(r.status === 204 ? '✅ BIZZ-726 → Done' : `⚠️ ${r.status}`);
}
