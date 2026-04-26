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
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const body = { type: 'doc', version: 1, content: [
  p(strong('Shipped — Option A — domain-admin inline under /dashboard/admin/domains/[id]/')),
  p(txt('Server-redirect droppet. Super-admin klik på domain-row holder dem i DashboardLayout hele vejen. Sidebar + topbar + AdminNavTabs forbliver synlige. Under det ligger DomainAdminTabs som sub-navigation.')),
  p(strong('Ny layout-stack:')),
  cb(
`sidebar   (DashboardLayout — /dashboard/layout.tsx)
topbar    (samme)
AdminNavTabs  (Brugere | Fakturering | ... | Domains)
DomainAdminTabs  (Oversigt | Brugere | Skabeloner | Dokumenter | Historik | Indstillinger)
content   (inline-render af eksisterende client components)`,
    'text'
  ),
  p(strong('Ændrede/nye filer:')),
  cb(
`/dashboard/admin/domains/[id]/page.tsx         — drop redirect, render inline
/dashboard/admin/domains/[id]/layout.tsx       — ny, wrapper med DomainAdminTabs
/dashboard/admin/domains/[id]/users/page.tsx   — ny, DomainUsersClient
/dashboard/admin/domains/[id]/templates/...    — ny, TemplatesListClient
/dashboard/admin/domains/[id]/training/...     — ny, TrainingDocsClient
/dashboard/admin/domains/[id]/audit/...        — ny, AuditLogClient
/dashboard/admin/domains/[id]/settings/...     — ny, DomainSettingsClient
/domain/[id]/admin/DomainAdminTabs.tsx         — hrefBase + backHref props`,
    'text'
  ),
  p(strong('Tenant-scope unchanged: '), code('/domain/[id]/admin/*'), txt(' fungerer stadig for tenant members (ikke super-admins). Samme client components serveres i begge scopes — shared via props.')),
  p(strong('Commit: '), code('93da8c6'), txt('. Tests 1626/1640 grønne, type-check clean. '), strong('→ In Review.')),
]};
const cr = await req('POST', '/rest/api/3/issue/BIZZ-761/comment', { body });
console.log(cr.status === 201 ? 'comment ok' : 'fail', cr.status);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-761/transitions');
const t = (JSON.parse(tr.body).transitions || []).find(x => /^in review$/i.test(x.name));
if (t) { const r = await req('POST', '/rest/api/3/issue/BIZZ-761/transitions', { transition: { id: t.id } }); console.log(r.status === 204 ? '-> In Review' : 'warn'); }
