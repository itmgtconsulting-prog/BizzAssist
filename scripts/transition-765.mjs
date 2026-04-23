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
  p(strong('Shipped — rename + stats cards + filter pills')),
  p(strong('Issue 1 — rename:'), txt(' AdminNavTabs tab-label "Planer" → "Plan" (både DA og EN). PlansClient header "Plankonfiguration" → "Plan".')),
  p(strong('Issue 2 — layout alignment:'), txt(' Tilføjet 4 KPI-cards + 4 filter-pills øverst i content-området (matches users + billing pattern).')),
  p(strong('Stats cards:')),
  ul(
    li(p(txt('Planer (total count)'))),
    li(p(txt('AI-aktive (count where aiEnabled=true)'))),
    li(p(txt('Kræver godkendelse (count where requiresApproval=true)'))),
    li(p(txt('Token-pakker (packs.length)'))),
  ),
  p(strong('Filter pills:'), txt(' Alle | AI-aktive | Uden AI | Kræver godkendelse. Filter-state er lokal og applies direkte på '), code('plans.map'), txt('.')),
  p(strong('Scope-note:'), txt(' den fulde table-refactor (extract inline form-grid til tabular list med drawer-edit) forbliver L-effort per BIZZ-741-analysen — parkeret. Dette ticket shipper navngivning + alignment-pieces uden at restructure editing surface.')),
  p(strong('Commit: '), code('321b182'), txt('. Tests 1626/1640 grønne. '), strong('→ In Review.')),
]};
const cr = await req('POST', '/rest/api/3/issue/BIZZ-765/comment', { body });
console.log(cr.status === 201 ? 'comment ok' : 'fail', cr.status);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-765/transitions');
const t = (JSON.parse(tr.body).transitions || []).find(x => /^in review$/i.test(x.name));
if (t) { const r = await req('POST', '/rest/api/3/issue/BIZZ-765/transitions', { transition: { id: t.id } }); console.log(r.status === 204 ? '-> In Review' : 'warn'); }
