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
  h(2, 'Shipped — 4 M-effort admin-tabs aligned'),
  p(strong('Scope: '), txt('M-effort tabs fra BIZZ-741 analysen (Analytics, Service-Management, Cron-Status, Domains). L-effort tabs (Plans, AI-Media-Agents, Security, Service-Manager) parkeret som follow-up.')),
  h(3, 'Per tab'),
  ul(
    li(p(strong('Cron-Status — '), txt('inline stats ("10/15 OK · 2 fejl") → 4 KPI cards + search + status-filter pill row. Table-rows filtreres nu.'))),
    li(p(strong('Service-Management — '), txt('4 KPI cards (Total/Operational/Degraded/Down) + search der filtrerer service-grid.'))),
    li(p(strong('Domains — '), txt('4 KPI cards (Total/Active/Suspended/Archived) + search + status-filter pill row + friendly empty-state.'))),
    li(p(strong('Analytics — '), txt('search + language filter. Client-side filter på topUnmatched/topPages/recentUnmatched — ingen backend ændring.'))),
  ),
  h(3, 'Reference-design alignment (matches /users + /billing)'),
  ul(
    li(p(txt('KPI cards: '), code('bg-slate-900/50 border border-slate-700/40 rounded-xl p-4'), txt(' med icon + label + value'))),
    li(p(txt('Search input: '), code('bg-slate-800/60 border border-slate-700/50 rounded-lg'), txt(' med Search-icon i left-pad'))),
    li(p(txt('Filter dropdown: samme styling + "Alle X" option'))),
  ),
  h(3, 'Ikke i scope (L-effort → separate tickets)'),
  ul(
    li(p(code('Plans'), txt(' — extract inline-form til table + drawer-edit'))),
    li(p(code('AI-Media-Agents'), txt(' + '), code('Security'), txt(' — settings-form wrapping i stat-cards + ny metric-endpoint'))),
    li(p(code('Service-Manager'), txt(' — KPI row + reorg sub-nav (tabs for deployments/scans/fixes)'))),
  ),
  p(strong('Commit: '), code('9332823'), txt('. Tests 1626/1640 grønne. '), strong('→ In Review.'))
);

const cr = await req('POST', `/rest/api/3/issue/BIZZ-739/comment`, { body });
console.log(cr.status === 201 ? '✅ BIZZ-739 comment' : `❌ ${cr.status}`);
const tr = await req('GET', `/rest/api/3/issue/BIZZ-739/transitions`);
const target = (JSON.parse(tr.body).transitions || []).find(t => /^in review$/i.test(t.name));
if (target) {
  const r = await req('POST', `/rest/api/3/issue/BIZZ-739/transitions`, { transition: { id: target.id } });
  console.log(r.status === 204 ? '  ✅ BIZZ-739 → In Review' : `  ⚠️ ${r.status}`);
}
