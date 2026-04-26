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
  h(2, 'Playwright-verifikation — PASS (6/6 acceptance-criteria)'),
  p(strong('Test: '), code('GET /api/search?q=Arnold+Nielsens+Boulevard+62'), txt(' returnerer '), strong('alle 4 lejligheder'), txt(' plus begge hovedejendomme (tidligere manglede 62A\'s lejligheder).')),
  h(3, 'Resultat'),
  ul(
    li(p(code('✅ 62A hovedejendom'), txt(' (adgangsadresse)'))),
    li(p(code('✅ 62B hovedejendom'), txt(' (adgangsadresse)'))),
    li(p(code('✅ 62A 1.sal'), txt(' (lejlighed — '), strong('TIDLIGERE MANGLENDE'), txt(')'))),
    li(p(code('✅ 62A st.'), txt(' (lejlighed — '), strong('TIDLIGERE MANGLENDE'), txt(')'))),
    li(p(code('✅ 62B 1.sal'), txt(' (lejlighed)'))),
    li(p(code('✅ 62B st.'), txt(' (lejlighed)'))),
  ),
  p(txt('Plus 62C hovedejendom som bonus. 7 address hits total, 17 hits med andre typer.')),
  h(3, 'Implementation'),
  p(txt('Flere commits landede fix: '), code('015ba29'), txt(' (probe dawa /adresser for units), '), code('a5c8f37/b5153ad/ed2be35/405d7f9'), txt(' (debug), '), code('d48fbd5'), txt(' (bump address cap fra 5 til 10 + fjern debug).')),
  p(strong('→ Done.'))
);

const cr = await req('POST', '/rest/api/3/issue/BIZZ-723/comment', { body });
console.log(cr.status === 201 ? '✅ BIZZ-723 comment posted' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-723/transitions');
const done = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
if (done) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-723/transitions', { transition: { id: done.id } });
  console.log(r.status === 204 ? '✅ BIZZ-723 → Done' : `⚠️ ${r.status}`);
}
