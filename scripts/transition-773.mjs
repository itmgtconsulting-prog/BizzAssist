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
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });
const body = { type: 'doc', version: 1, content: [
  p(strong('Iter 1 shipped — top-level tabs på domain dashboard')),
  p(txt('6 tabs: Oversigt | Sager | Skabeloner | Dokumenter | Historik | Indstillinger. Sager er fuldt rendered inline (beholder nuværende cases-grid + search + status-filter + bulk actions). Admin-tabs (skabeloner/dokumenter/historik/indstillinger) linker ud til eksisterende admin-routes når user er admin, shown disabled for regular members.')),
  p(strong('Iter 2 scope (parked):')),
  ul(
    li(p(txt('Split-view under Sager-tab (liste venstre, detalje højre, resizable divider)'))),
    li(p(txt('AIChatPanel som collapsible side-panel med case+template kontekst'))),
    li(p(txt('Inline rendering af templates/documents/audit/settings-tabs uden navigation out'))),
    li(p(txt('Oversigt-tab med stats-kort + recent activity'))),
  ),
  p(strong('Commit: '), code('92f13cc'), txt('. Tests 1626/1640 grønne. '), strong('→ In Review (partial — iter 2 forbliver scope-tracked i ticket).')),
]};
const cr = await req('POST', '/rest/api/3/issue/BIZZ-773/comment', { body });
console.log(cr.status === 201 ? 'ok' : 'fail', cr.status);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-773/transitions');
const t = (JSON.parse(tr.body).transitions || []).find(x => /^in review$/i.test(x.name));
if (t) { const r = await req('POST', '/rest/api/3/issue/BIZZ-773/transitions', { transition: { id: t.id } }); console.log(r.status === 204 ? '-> In Review' : 'warn'); }
