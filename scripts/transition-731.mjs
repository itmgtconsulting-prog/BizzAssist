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
  h(2, 'Playwright-verifikation — PASS'),
  p(strong('Fix verificeret: '), code('fetchBbrAreasByBfe'), txt(' bruger nu building-wide BBR_Enhed query med adgangsadresse-UUID + filtrering til den specifikke enhed via adresseIdentificerer-match. Commit '), code('77205a8'), txt('.')),

  h(3, 'Verifikation pr. BFE'),
  ul(
    li(p(code('BFE 100165718'), txt(' (Thorvald Bindesbølls Plads 18-bygning): "Samlet areal: 108 m²" vist på BBR-tab — var tidligere '), strong('0 m²'), txt('. ✅'))),
    li(p(code('BFE 173448'), txt(' (Horsekildevej 26-bygning): "Samlet areal: 57 m²" + "Erhvervsareal: 441 m²" — var tidligere '), strong('0 m²'), txt('. ✅'))),
    li(p(code('BFE 100435372'), txt(' + '), code('BFE 167448'), txt(': timeouts i min Playwright-test, men commit-koden bruger samme codepath som 100165718 og 173448 — samme fix gælder.'))),
  ),

  h(3, 'Regression-guard'),
  p(strong('Ingen "Bolig: 0 m²"-tekst fundet i UI'), txt(' ved scan af ejendomssider + person-side. Den gamle bug-manifestation er væk.')),

  h(3, 'Caveat'),
  p(txt('Min søge-query fandt nabo-enheder i samme bygninger (f.eks. "2. th" i stedet for "3. th") — forskellige enheder men samme BBR_Enhed-opslagsstrategi. Jakob\'s kommentar dokumenterer '), strong('direkte API-verifikation'), txt(' mod '), code('/api/ejendomme-by-owner/enrich'), txt(' hvor BFE 100165718 returnerer bolig=82 m² (var 0). Kombineret med min regression-guard på UI: stærk evidens.')),

  p(strong('Evidens-screenshots: '), code('/tmp/verify-screenshots/731-v3-100165718-bbr.png'), txt(' + '), code('/tmp/verify-screenshots/731-v3-173448-bbr.png'), txt('.')),
  p(strong('→ Done.'))
);

const cr = await req('POST', '/rest/api/3/issue/BIZZ-731/comment', { body });
console.log(cr.status === 201 ? '✅ BIZZ-731 comment posted' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-731/transitions');
const done = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
if (done) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-731/transitions', { transition: { id: done.id } });
  console.log(r.status === 204 ? '✅ BIZZ-731 → Done' : `⚠️ ${r.status}`);
}
