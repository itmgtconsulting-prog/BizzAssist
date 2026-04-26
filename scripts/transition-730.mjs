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
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

const body = doc(
  h(2, 'Playwright-verifikation — PASS (5/5)'),
  p(strong('Test-scenarie: '), code('/dashboard/owners/4000115446'), txt(' (Jakob Juul Rasmussen) → Diagram-tab. Commit '), code('22d8335'), txt('.')),
  ul(
    li(p(strong('Container-node "Personligt ejede ejendomme" synlig '), txt('i diagrammet (SVG-scan bekræftede).'))),
    li(p(strong('Tæller-label: '), code('"9 ejendomme"'), txt(' — container vises med korrekt antal.'))),
    li(p(strong('Ejendomme synlige under container: '), txt('Hovager, Søbyvej, Vigerslevvej, Kildegårdsvej, Stårupvej — alle fundet.'))),
    li(p(strong('Virksomheder stadig synlige '), txt('(regression-guard): JaJR Holding, IT Management, ProductLife, Pharma IT.'))),
    li(p(strong('3-lags struktur virker: '), txt('person → virksomheder/container → ejendomme under container. Edges re-routes via virtuel container-node.'))),
  ),
  p(strong('Evidens: '), code('/tmp/verify-screenshots/730-jakob-diagram.png'), txt(' (full-page med Udvid-knap aktiveret).')),
  p(strong('→ Done.'))
);

const cr = await req('POST', '/rest/api/3/issue/BIZZ-730/comment', { body });
console.log(cr.status === 201 ? '✅ BIZZ-730 comment posted' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-730/transitions');
const done = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
if (done) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-730/transitions', { transition: { id: done.id } });
  console.log(r.status === 204 ? '✅ BIZZ-730 → Done' : `⚠️ ${r.status}`);
}
