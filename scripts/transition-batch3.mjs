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
const cb = (t) => ({ type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: t }] });
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

const perTicket = {
  'BIZZ-763': doc(
    p(strong('Shipped — matrikel-search fra udfaset-banner')),
    p(strong('Button:'), txt(' knappen på '), code('EjendomDetaljeClient'), txt(' navigerer nu til '), code('/dashboard/search?type=matrikel&ejerlavKode=X&matrikelnr=Y&ejerlavNavn=Z'), txt(' i stedet for '), code('/dashboard?q=...'), txt('.')),
    p(strong('Search page:'), txt(' '), code('UniversalSearchPageClient'), txt(' læser query-params via '), code('useSearchParams'), txt('. Når '), code('type=matrikel'), txt(' er sat, bypasses de 3 normale tabs og der kaldes '), code('/api/ejerlejligheder'), txt(' (som genbruger BIZZ-724 Tinglysning + DAWA matrikel-chain).')),
    p(strong('Results:'), txt(' property-kort linked til '), code('/dashboard/ejendomme/[dawaId eller bfe]'), txt('. Empty-state, loading, error alle covered. Header viser matrikel+ejerlav kontext + back-link til fri søgning.')),
    p(strong('Commit: '), code('124ec08'), txt('. Tests 1626/1640 grønne. '), strong('→ In Review.')),
  ),
  'BIZZ-761': doc(
    p(strong('Re-transition — allerede shipped i commit 93da8c6')),
    p(txt('Verificeret i kode:')),
    cb(
`app/dashboard/admin/AdminNavTabs.tsx:126            href: '/dashboard/admin/domains'
app/dashboard/admin/domains/DomainsListClient.tsx:310  router.push('/dashboard/admin/domains/{id}')
app/dashboard/admin/domains/[id]/layout.tsx            wrapper med DomainAdminTabs
app/dashboard/admin/domains/[id]/page.tsx              DomainAdminDashboardClient inline
app/dashboard/admin/domains/[id]/users/page.tsx        DomainUsersClient inline
app/dashboard/admin/domains/[id]/templates/page.tsx    TemplatesListClient inline
app/dashboard/admin/domains/[id]/training/page.tsx     TrainingDocsClient inline
app/dashboard/admin/domains/[id]/audit/page.tsx        AuditLogClient inline
app/dashboard/admin/domains/[id]/settings/page.tsx     DomainSettingsClient inline`
    ),
    p(txt('Layout-stack nu: sidebar → topbar → AdminNavTabs → DomainAdminTabs → content. Ingen context-switch ved klik på domain-row. '), strong('→ In Review.')),
  ),
  'BIZZ-762': doc(
    p(strong('Re-transition — allerede shipped i commit 93da8c6')),
    p(txt('Tilbage-pil destination styres af '), code('backHref'), txt(' prop på '), code('DomainAdminTabs'), txt('. Super-admin layout sætter den til '), code('/dashboard/admin/domains'), txt(':')),
    cb(
`app/dashboard/admin/domains/[id]/layout.tsx:
  <DomainAdminTabs
    domainId={id}
    hrefBase="/dashboard/admin/domains/{id}"
    backHref="/dashboard/admin/domains"
  />`
    ),
    p(txt('Tenant-scope '), code('/domain/[id]/admin/*'), txt(' beholder default '), code('/domain/[id]'), txt(' for tenant members. '), strong('→ In Review.')),
  ),
  'BIZZ-764': doc(
    p(strong('Re-transition — løst af BIZZ-761 (commit 93da8c6)')),
    p(txt('Dette ticket dublerer BIZZ-761. Alle punkter i "Ønsket løsning — Option A":')),
    cb(
`✓ "Domains" som fast tab i admin-menustrukturen
  AdminNavTabs.tsx har Domains-tab med href=/dashboard/admin/domains
✓ Domain-oversigten (stats-kort, tabel) inline i admin-layout
  /dashboard/admin/domains/page.tsx + DomainsListClient har KPI-cards +
  search + status-filter (BIZZ-739 + BIZZ-747)
✓ Klik på domain → undermenuer inden for admin
  /dashboard/admin/domains/[id]/layout.tsx + DomainAdminTabs sub-nav
✓ Admin-tabs forbliver synlige hele tiden
  DashboardLayout + AdminNavTabs bevares via route-nesting
✓ Breadcrumb-style: Admin > Domains > [Domain navn]
  DomainAdminTabs header viser domain.name + "Administration" label
✓ Centraliser admin-tabs i AdminTabBar
  AdminNavTabs er shared (BIZZ-737) — 9+2 pages bruger den`
    ),
    p(strong('→ In Review som duplikat af BIZZ-761.')),
  ),
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
