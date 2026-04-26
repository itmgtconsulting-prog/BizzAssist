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

const perTicket = {
  'BIZZ-766': { type: 'doc', version: 1, content: [
    p(strong('Shipped — rename + layout verified')),
    p(txt('Tab-label "Analyse" matcher nu overskriften i '), code('AnalyticsClient'), txt(' ("Support-analyse" → "Analyse"). Stats-cards + language-filter shipped allerede i BIZZ-739, så layout-alignment er komplet.')),
    p(strong('Phase 2/3/4 roadmap (parkeret):'), txt(' klusterering af umatchede spørgsmål, AI Assistant analytics sub-tabs, CSV/PDF eksport — alt er dokumenteret i ticket-beskrivelsen og kan laves som follow-up epic.')),
    p(strong('Commit: '), code('78b6664'), txt('. '), strong('→ In Review.')),
  ]},
  'BIZZ-767': { type: 'doc', version: 1, content: [
    p(strong('Shipped — 4 KPI-cards på AI-agenter siden')),
    p(txt('Gul grænse (confidenceThreshold%) · Grøn grænse (greenThreshold%) · Primære medier count · Ekskluderede count. Matches users+billing pattern (bg-slate-900/50 + border-slate-700/40 + icon+label+value).')),
    p(strong('Commit: '), code('78b6664'), txt('. '), strong('→ In Review.')),
  ]},
  'BIZZ-768': { type: 'doc', version: 1, content: [
    p(strong('Shipped — 4 KPI-cards på Security siden')),
    p(txt('Idle-timeout · Absolute timeout · Refresh-days · 2FA-status. Settings-sliders forbliver nedenfor uændret.')),
    p(strong('Commit: '), code('78b6664'), txt('. '), strong('→ In Review.')),
  ]},
  'BIZZ-769': { type: 'doc', version: 1, content: [
    p(strong('Shipped — pagination på Service Manager deployments')),
    p(strong('API:'), txt(' '), code('GET /api/admin/service-manager?limit=N'), txt(' accepterer 10-100 records. Default raised fra 10 til 50.')),
    p(strong('UI:'), txt(' ny '), code('<PaginationBar>'), txt('-komponent med first/prev/next/last + page count + "Viser X-Y af Z". Rendered '), strong('både i top og bund'), txt(' af deployments-tabellen (ticket-spec).')),
    p(strong('Controls:'), txt(' page-size selector (10/20/50) + fetch-limit selector (10/25/50/100) lader brugeren trade off API-kald vs paginations-dybde. Resetter til side 1 når nogen af dem ændres.')),
    p(strong('Scope-note:'), txt(' true cursor-based infinite history via Vercels '), code('until'), txt('-param er parkeret. 100-record cap dækker ~1 måneds deployments ved nuværende velocity.')),
    p(strong('Commit: '), code('78b6664'), txt('. '), strong('→ In Review.')),
  ]},
};

for (const [key, body] of Object.entries(perTicket)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const target = (JSON.parse(tr.body).transitions || []).find((t) => /^in review$/i.test(t.name));
  if (target) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → In Review` : `  ⚠️ ${r.status}`);
  }
}
