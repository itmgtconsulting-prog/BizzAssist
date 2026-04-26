#!/usr/bin/env node
/**
 * Batch-opretter 15 UX/alignment tickets baseret på deep analysis af
 * admin + domain modulerne. Grupperet i P0 / P1 / P2.
 */
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
const plainBody = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const tickets = [
  // ─── P0: Broken functionality ────────────────────────────────────
  { priority: 'Highest', labels: ['domain', 'admin', 'p0-broken', 'navigation'],
    summary: 'Admin Domains list: rows ikke klikbare — kan ikke drill-down til domain detail',
    body: 'P0 BROKEN. /dashboard/admin/domains/DomainsListClient.tsx viser liste af domains men rows har ingen href/onClick — super-admin kan ikke klikke sig ind på et domain for at se detaljer, suspend/activate/edit. Fix: tilføj <Link href={`/dashboard/admin/domains/${domain.id}`}> på hver row. Kræv også at den tilhørende detail-side eksisterer (evt. ny page.tsx + client component). Reference-pattern: /dashboard/ejendomme list-siden hvor rows linker til /dashboard/ejendomme/[id].' },
  { priority: 'High', labels: ['domain', 'admin', 'p0-broken', 'search', 'templates'],
    summary: 'Domain Templates list: mangler søgning — bliver ubrugelig ved 100+ templates',
    body: 'P0 BROKEN. /app/domain/[id]/admin/templates/TemplatesListClient.tsx renderer liste uden søgefelt, filter eller sort. Ticket-spec for domain havde max_templates=100 default — uden søgning er listen ubrugelig ved scale. Fix: tilføj <input type="text" placeholder="Søg skabeloner..." /> med filter-logic (lowercase includes på name + description). Samme pattern som ejendomme-søgning.' },
  { priority: 'High', labels: ['domain', 'admin', 'p0-broken', 'pagination', 'audit'],
    summary: 'Domain Audit-log + Training-docs: verificér pagination (kan hænge ved store datasets)',
    body: 'P0 POTENTIAL BROKEN. /app/domain/[id]/admin/audit/AuditLogClient.tsx og /app/domain/[id]/admin/training/TrainingDocsClient.tsx loader sandsynligvis alle rækker uden pagination. Audit-log API har limit 500 JSON / 5000 CSV. Verificér: renderer UIen listen nedad med lazy-load eller pagination, eller crasher den ved 500+ entries? Fix hvis nødvendigt: tilføj pagination (typisk 50 pr side) eller infinite-scroll.' },

  // ─── P1: UX inconsistency ────────────────────────────────────────
  { priority: 'High', labels: ['admin', 'p1-ux', 'navigation', 'tabs'],
    summary: 'Admin: tilføj AdminNavTabs til ai-feedback + release-manager pages',
    body: 'P1 UX. 2 admin-sider mangler tab-bar: /dashboard/admin/ai-feedback/AIFeedbackClient.tsx og /dashboard/admin/release-manager/ReleaseManagerClient.tsx. Andre 11 admin-pages har tab-bar (Brugere|Fakturering|Planer|Analyse|AI-agenter|Sikkerhed|Service Manager|Infrastruktur|Cron-status). Bruger på disse 2 sider kan ikke navigere ud via tab-bar — kun sidebar. Fix: tilføj samme tab-struktur (eller bedre: extract til shared AdminNavTabs komponent per BIZZ-737). ' },
  { priority: 'High', labels: ['domain', 'p1-ux', 'search', 'users'],
    summary: 'Domain Users list: mangler søgning på email/navn',
    body: 'P1 UX. /app/domain/[id]/admin/users/DomainUsersClient.tsx viser member-list uden søgefelt. Ticket-spec havde max_users=50 default — men i større domains er det svært at finde en specifik bruger. Admin users-siden har allerede email/name-search (reference: /dashboard/admin/users/UsersClient.tsx). Fix: kopiér samme search-input + filter-logic.' },
  { priority: 'Medium', labels: ['admin', 'p1-ux', 'navigation', 'breadcrumb'],
    summary: 'Admin: breadcrumb viser ikke "Dashboard > Admin > [sektion]"-hierarki',
    body: 'P1 UX. /dashboard/admin/layout.tsx validerer kun rolle — ingen visuel breadcrumb. Bruger på fx /dashboard/admin/billing ved ikke hvor de er i navigation-træet. Ejendomme-detail-siderne har "Tilbage til ejendomme" + titel. Admin mangler tilsvarende kontekst. Fix: tilføj breadcrumb-komponent i admin/layout.tsx eller i hver admin client (Dashboard > Admin > Fakturering).' },
  { priority: 'Medium', labels: ['domain', 'p1-ux', 'navigation', 'back-link'],
    summary: 'Domain: "Tilbage til dashboard"-links er upræcise — bør navngive domainet',
    body: 'P1 UX. /app/domain/[id]/admin/*/ client-komponenter bruger "Tilbage til dashboard" — uklart om det betyder BizzAssist-dashboard eller Domain-admin-dashboard. Ejendomme bruger "Tilbage til ejendomme" (specifikt). Fix: ændr til "Tilbage til [Domain name]-admin" eller tilføj breadcrumb "Domain > Admin > [Sektion]". Kræv at domain-navn trækkes fra parent.' },
  { priority: 'Medium', labels: ['admin', 'p1-ux', 'empty-state'],
    summary: 'Admin: empty-state cards mangler på users/plans/billing lister',
    body: 'P1 UX. Når lister er tomme viser admin-siderne blank indhold — ingen vejledning om "opret den første bruger" / "tilføj en plan". Reference: /dashboard/ejendomme tom-tilstand har styled card (bg-slate-900/50 border rounded-xl p-6 text-center) med ikon + titel + hjælpe-tekst. Fix: tilføj EmptyState-komponent (kan genbruges) til mindst: /dashboard/admin/users, /dashboard/admin/plans, /dashboard/admin/billing ved 0 resultater.' },
  { priority: 'Medium', labels: ['admin', 'p1-ux', 'filter'],
    summary: 'Admin Users: filter-UI bør matche ejendomme-pattern (grupperet filter-card + reset)',
    body: 'P1 UX. /dashboard/admin/users/UsersClient.tsx:213-230 har search + plan-dropdown inline. Ejendomme-pattern: dedicated filter-panel-card med grupperede filters (kommune, type, status) + "Nulstil filtre"-knap. Giver bedre discoverability af hvilke filtre der er. Fix: refactor til FilterPanel-komponent (evt. shared med ejendomme/virksomheder).' },

  // ─── P2: Nice-to-have polish ─────────────────────────────────────
  { priority: 'Low', labels: ['admin', 'p2-polish', 'sorting'],
    summary: 'Admin Users: tilføj column-sorting (email/navn/status/plan)',
    body: 'P2 POLISH. /dashboard/admin/users/UsersClient.tsx viser bruger-liste uden sortable columns. For admin-efficiency skal columns kunne klikkes (ascending/descending toggle). Fix: tilføj <th onClick> + sort-state + sort-function på de 4 kolonner.' },
  { priority: 'Low', labels: ['domain', 'p2-polish', 'sorting', 'templates'],
    summary: 'Domain Templates: tilføj sort-dropdown (navn/dato/status)',
    body: 'P2 POLISH. /app/domain/[id]/admin/templates/TemplatesListClient.tsx mangler sort-option. Fix: dropdown med 3 options (navn A-Å, nyeste først, status).' },
  { priority: 'Low', labels: ['domain', 'p2-polish', 'users', 'ui'],
    summary: 'Domain Users: tilføj rolle-badges (grøn "Admin" / grå "Member")',
    body: 'P2 POLISH. /app/domain/[id]/admin/users/DomainUsersClient.tsx viser rolle som ren tekst. Admin-users side bruger StatusBadge med farver. Fix: tilføj farve-kodede badges (grøn bg for admin, grå for member).' },
  { priority: 'Low', labels: ['domain', 'p2-polish', 'breadcrumb', 'case'],
    summary: 'Domain Case detail: tilføj breadcrumb "Domain > Sager > [navn]"',
    body: 'P2 POLISH. /app/domain/[id]/case/[caseId]/CaseDetailClient.tsx mangler breadcrumb. Bruger mister kontekst ved dybe navigation. Fix: tilføj breadcrumb-bar over case-indholdet der viser Domain navn > Sager-link > case navn.' },
  { priority: 'Low', labels: ['domain', 'p2-polish', 'bulk-actions'],
    summary: 'Domain Case-list: tilføj bulk-actions (arkivér / slet flere)',
    body: 'P2 POLISH. /app/domain/[id]/DomainUserDashboardClient.tsx viser cases-liste uden bulk actions. Power-user feature: checkbox pr row + bulk-archive/bulk-delete knap. Fix: tilføj selection-state + 2 bulk-action-knapper over tabel.' },
  { priority: 'Low', labels: ['domain', 'p2-polish', 'refactor'],
    summary: 'Domain: extract Case-list til shared DomainCaseList.tsx-komponent',
    body: 'P2 REFACTOR. /app/domain/[id]/DomainUserDashboardClient.tsx har case-list rendering inline. Følg pattern fra BIZZ-657 som extract\'de ejendomme-tabs. Fix: opret DomainCaseList.tsx komponent med props (cases, onCaseClick, filters) der kan bruges både på user-dashboard og evt. admin-oversigt.' },
];

console.log(`Opretter ${tickets.length} tickets...`);
const created = [];
for (const t of tickets) {
  const res = await req('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: PROJECT },
      issuetype: { name: 'Task' },
      priority: { name: t.priority },
      summary: t.summary,
      labels: t.labels,
      description: plainBody(t.body),
    },
  });
  if (res.status !== 201) {
    console.log(`❌ FAIL: ${t.summary.slice(0, 60)} — ${res.status} ${res.body.slice(0, 150)}`);
    continue;
  }
  const key = JSON.parse(res.body).key;
  created.push({ key, summary: t.summary });
  console.log(`✅ ${key} [${t.priority}] ${t.summary.slice(0, 70)}`);
}
console.log(`\nTotal oprettet: ${created.length}/${tickets.length}`);
console.log('Keys:', created.map(c => c.key).join(', '));
