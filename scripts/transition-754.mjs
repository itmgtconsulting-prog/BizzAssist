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
const body = { type: 'doc', version: 1, content: [
  p(strong('Shipped — grouped filter-card + Nulstil filtre-knap')),
  p(txt('Search + plan-filter flyttet fra inline under tab-bar til dedikeret filter-card med "Filtre"-header. Reset-knap vises kun når mindst ét filter er aktivt og clearer '), code('searchQuery + planFilter'), txt(' i ét klik. Matches ejendomme-style.')),
  p(strong('Scope-note: '), txt('ikke extracted til shared '), code('<FilterPanel>'), txt('-komponent endnu — shared-extract bliver værd det når 3+ sider har det samme pattern. Nuværende inline-version kan lifte senere.')),
  p(strong('Commit: '), code('1d6105c'), txt('. '), strong('→ In Review.')),
]};
const cr = await req('POST', '/rest/api/3/issue/BIZZ-754/comment', { body });
console.log(cr.status === 201 ? 'comment ok' : 'fail', cr.status);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-754/transitions');
const t = (JSON.parse(tr.body).transitions || []).find(x => /^in review$/i.test(x.name));
if (t) { const r = await req('POST', '/rest/api/3/issue/BIZZ-754/transitions', { transition: { id: t.id } }); console.log(r.status === 204 ? '-> In Review' : 'warn'); }
