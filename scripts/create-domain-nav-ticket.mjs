#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';
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
const ol = (...i) => ({ type: 'orderedList', content: i });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });

const desc = {
  type: 'doc', version: 1, content: [
    h(2, 'Problem'),
    p(txt('Super-admin UI på '), code('/dashboard/admin/domains'), txt(' (BIZZ-701) findes og er funktionel, men der er ingen tab-link til den fra den eksisterende admin tab-bar. Super-admins skal skrive URL\'en direkte for at nå siden — ellers kan de ikke finde Domain Management-funktionaliteten.')),
    p(strong('Observation 2026-04-22:'), txt(' Jakob navigerede til '), code('/dashboard/admin/users'), txt(' og så tab-bar: Brugere | Fakturering | Planer | Analyse | AI-agenter | Sikkerhed | Service Manager | Infrastruktur | Cron-status. INGEN "Domains"-tab.')),

    h(2, 'Kontekst'),
    p(txt('Tab-bar er hardcoded i flere admin Client-komponenter — samme struktur gentages på hver side (duplikeret kode). Fx:')),
    ul(
      li(p(code('app/dashboard/admin/users/UsersClient.tsx:217-270'))),
      li(p(code('app/dashboard/admin/billing/BillingClient.tsx'), txt(' (formentlig samme pattern)'))),
      li(p(code('app/dashboard/admin/plans/PlansClient.tsx'))),
      li(p(code('app/dashboard/admin/analytics/AnalyticsClient.tsx'))),
      li(p(code('app/dashboard/admin/ai-media-agents/AiMediaAgentsClient.tsx'))),
      li(p(code('app/dashboard/admin/security/SecurityClient.tsx'))),
      li(p(code('app/dashboard/admin/service-manager/ServiceManagerClient.tsx'))),
    ),

    h(2, 'Acceptance criteria'),
    ol(
      li(p(txt('Tilføj ny "Domains"-tab-link i admin tab-bar — mellem Service Manager og Infrastruktur eller som sidste element (valg af placering er op til dev).'))),
      li(p(txt('Label: '), code('Domains'), txt(' (både '), code('da'), txt(' og '), code('en'), txt(' — ingen oversættelse nødvendig, navnet er teknisk).'))),
      li(p(txt('Icon: brug '), code('Shield'), txt(' (matching DomainNavMenu) eller '), code('Building'), txt(' fra lucide-react.'))),
      li(p(txt('Target href: '), code('/dashboard/admin/domains'), txt('.'))),
      li(p(txt('Tab-linken skal være feature-flag gated — '), code('isDomainFeatureEnabled()'), txt(' check før rendering (samme pattern som DomainNavMenu i '), code('app/dashboard/layout.tsx:723-730'), txt('). Når flag=false: skjul tabben.'))),
      li(p(txt('Aktiv-state: når '), code('pathname === "/dashboard/admin/domains"'), txt(' brug samme '), code('border-blue-500'), txt('/'), code('text-blue-300'), txt(' active styling som andre tabs.'))),
    ),

    h(2, 'Best-practice anbefaling'),
    p(txt('Tab-bar-koden er duplikeret på tværs af 9+ admin client-komponenter. Overvej at extract den til en shared '), code('<AdminNavTabs activeTab="users" />'), txt(' komponent og refactore alle 9 steder til at bruge den. Men scope-wise: for denne ticket er det nok at tilføje Domains-tab i ALLE 9 filer (eller ideelt extract-til-shared-komponent i samme PR).')),

    h(2, 'Test'),
    ol(
      li(p(txt('Login som super-admin på test.bizzassist.dk.'))),
      li(p(txt('Gå til '), code('/dashboard/admin/users'), txt(' → observer "Domains"-tab i tab-bar.'))),
      li(p(txt('Klik på Domains-tab → lander på '), code('/dashboard/admin/domains'), txt(' (list-view, sandsynligt tom på test-env uden seeded data).'))),
      li(p(txt('Verify tab også synligt fra billing, plans, analytics, security, service-manager sider.'))),
      li(p(txt('Toggle '), code('NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED=false'), txt(' lokalt → tab-linken forsvinder (regression-guard).'))),
    ),

    h(2, 'Relateret'),
    p(code('BIZZ-701'), txt(' — Super-admin Domain CRUD (UI shipped, men ikke linket fra admin-menu).')),
    p(code('BIZZ-699'), txt(' — Feature flag (blev ikke sat i Vercel environments ved ship — rettet 2026-04-22 15:08 via Management API).')),
    p(code('BIZZ-696'), txt(' — Domain Management Epic.')),
  ]
};

const res = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    issuetype: { name: 'Task' },
    priority: { name: 'High' },
    summary: 'Domain: tilføj "Domains"-tab i admin-nav (link til /dashboard/admin/domains)',
    labels: ['domain', 'admin', 'navigation', 'ux', 'quick-fix'],
    description: desc,
    parent: { key: 'BIZZ-696' },
  },
});
if (res.status !== 201) {
  console.error('FAIL:', res.status, res.body.slice(0, 400));
  process.exit(1);
}
const key = JSON.parse(res.body).key;
console.log(`✅ Created ${key} — admin Domains tab-nav`);

// Link som follow-up af BIZZ-701
await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key: 'BIZZ-701' },
  outwardIssue: { key },
});
console.log(`  🔗 ${key} relates to BIZZ-701`);
