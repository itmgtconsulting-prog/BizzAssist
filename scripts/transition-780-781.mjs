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

const perTicket = {
  'BIZZ-780': { type: 'doc', version: 1, content: [
    p(strong('Iter 1 shipped — breadcrumb anchor i admin-scope')),
    p(txt('Super-admin scope ('), code('/dashboard/admin/domains/[id]/*'), txt(') rendrer nu en breadcrumb øverst i '), code('DomainAdminTabs'), txt(': '), strong('Admin > Domains > [navn]'), txt(' med klikbare links til begge parent-pages. Tenant-scope ('), code('/domain/[id]/admin/*'), txt(') beholder den eksisterende header-kun layout.')),
    p(strong('Iter 2 (parkeret):'), txt(' master-detail split-view med domain-listen i venstre kolonne + detalje i højre. Kræver at layout.tsx wrapper children med en sidebar komponent der hydrerer domain-listen og highlighter nuværende valgte.')),
    p(strong('Commit: '), code('f637104'), txt('. '), strong('→ In Review.')),
  ]},
  'BIZZ-781': { type: 'doc', version: 1, content: [
    p(strong('Iter 1 shipped — header-alignment med company/ejendom/person pattern')),
    p(txt('DomainUserDashboardClient har nu standard detail-page header:')),
    ul(
      li(p(txt('Breadcrumb øverst (Dashboard > Domain)'))),
      li(p(txt('Stor H1 med shield-icon'))),
      li(p(txt('Info-chips row: sager-count badge + admin-badge (hvis role=admin)'))),
      li(p(txt('Actions (Admin + Opret sag) right-aligned i samme button-styling'))),
      li(p(txt('Duplikeret "Sager"-header inde i cases-tab fjernet — tabs tager over som section-delimiter'))),
    ),
    p(strong('Iter 2 (parkeret):'), txt(' fetche domain.name via '), code('/api/domain/mine'), txt(' så headeren viser faktisk domain-navn i stedet for hardcoded "Domain". Stats-cards i Oversigt-tab med sager/dokumenter/generationer per måned. AI-chat side-panel integration (BIZZ-745 iter 2).')),
    p(strong('Commit: '), code('f637104'), txt('. '), strong('→ In Review.')),
  ]},
};

for (const [key, body] of Object.entries(perTicket)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const target = (JSON.parse(tr.body).transitions || []).find((t) => /^in review$/i.test(t.name));
  if (target) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → In Review` : `  ⚠️ ${r.status}`);
  }
}
