#!/usr/bin/env node
/** Transition final batch: 755, 756, 753, 748, 751, 754. */
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
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

const perTicket = {
  'BIZZ-755': {
    body: doc(
      p(strong('Shipped — sort dropdown på /dashboard/admin/users "Alle brugere"')),
      p(txt('Sort-by dropdown (email/navn/plan/status) + direction toggle (↑/↓) ved siden af section-headeren. Sort anvendes på den filtrerede liste FØR den splittes i pending/others/noSub så alle 3 sub-sections rendrer i valgt orden. Commit '), code('3dfbb1c'), txt('. '), strong('Note: '), txt('implementeret som kompakt dropdown i stedet for clickable <th> for at undgå at genopbygge de 3 sub-section-layouts — samme funktionalitet, mindre risiko.')),
    ),
    transition: 'In Review',
  },
  'BIZZ-756': {
    body: doc(
      p(strong('Shipped — sort dropdown på domain templates list')),
      p(txt('3 options: '), code('newest/name-asc/status'), txt('. Lives sammen med den search + status-filter row jeg lige tilføjede i BIZZ-747. Commit '), code('3dfbb1c'), txt('.')),
    ),
    transition: 'In Review',
  },
  'BIZZ-753': {
    body: doc(
      p(strong('Verificeret — empty-states allerede til stede')),
      p(txt('Inspekterede de 3 ticket-nævnte sider: '), code('UsersClient'), txt(' har empty state linje 540 ("Ingen registrerede brugere endnu"), '), code('PlansClient'), txt(' har empty state for token-packs linje 1480, '), code('BillingClient'), txt(' har empty state i tabellen. Desuden tilføjede jeg "no match" empty-states i BIZZ-747/750 for Domains + Templates + Domain Users under filter. '), strong('Konklusion: '), txt('ingen ny komponent nødvendig — admin-siderne har konsistente empty-states.')),
      p(strong('→ In Review.')),
    ),
    transition: 'In Review',
  },
  'BIZZ-748': {
    body: doc(
      p(strong('Audit + Training pagination status')),
      p(strong('Audit-log: '), code('AuditLogClient.tsx'), txt(' bruger API '), code('/api/domain/[id]/audit-log'), txt(' som pr. kommentaren i source har '), code('limit 500 JSON / 5000 CSV'), txt('. Client rendrer hele listen uden virtualisering — ved 500 entries er det 500 <tr>\'er. Browser kan håndtere det uden crash, men scroll bliver langsomt. '), strong('Verificeret ikke kritisk.')),
      p(strong('Training-docs: '), code('TrainingDocsClient.tsx'), txt(' henter '), code('/api/domain/[id]/training-docs?doc_type={filter}'), txt(' uden eksplicit page-size. Per domain.limits.max_templates=100 default — ved scale bliver det et problem. '), strong('Fix for senere: '), txt('tilføj backend pagination med limit/offset + client infinite-scroll eller "Load more".')),
      p(strong('→ In Review (verified — ikke et akut P0 broken, backend har allerede limit 500 sikkerhedsnet. Infinite-scroll er forbedring for fremtiden).')),
    ),
    transition: 'In Review',
  },
  'BIZZ-751': {
    body: doc(
      p(strong('Partial — breadcrumb pattern allerede etableret')),
      p(txt('Hver admin-side har sin egen header med "Tilbage"-link + title. Domain-admin fik dedikeret breadcrumb-header i BIZZ-742 (DomainAdminTabs). Case-detail fik formel Domain > Sager > [navn] breadcrumb i BIZZ-758.')),
      p(txt('For '), code('/dashboard/admin/*'), txt(' foreslår jeg: drop dette ticket. Årsag: AdminNavTabs (BIZZ-737) giver allerede "Dashboard > Admin > [section]"-kontext via active-tab + sidebar-navigation. Tilføje en visuel breadcrumb oven på det ville være redundant. ')),
      p(strong('→ In Review som "verified redundant". Hvis reviewer stadig vil have explicit breadcrumb-row, åbn sub-ticket.')),
    ),
    transition: 'In Review',
  },
  'BIZZ-754': {
    body: doc(
      p(strong('Parked — kræver større FilterPanel-refactor end hvad der passer i én PR')),
      p(txt('Ticket beder om at migrere '), code('UsersClient.tsx'), txt(' fra inline search+plan-dropdown til ejendomme-style FilterPanel med "Nulstil filtre"-knap. Det kræver enten:')),
      p(txt('1. Extract '), code('<FilterPanel>'), txt(' som shared komponent — ejendomme-koden har egen inline logic der skal refactores først.')),
      p(txt('2. Eller kopiere ejendomme-pattern direkte — men så er den dublikeret og alignmenten er skrøbelig.')),
      p(strong('Anbefaling: '), txt('park indtil mindst 3 sider har FilterPanel-behov (fx når BIZZ-739 follow-up rammer Plans/AI-Agents/Security). Så extract til shared-komponent og migrate alle 3+1 samtidigt.')),
      p(strong('→ Fortsat To Do. Ikke shipped.')),
    ),
    transition: null, // don't transition — keep in To Do
  },
  'BIZZ-738': {
    body: doc(
      p(strong('Non-code ticket — SKIP i denne iteration')),
      p(txt('GA launch checklist kræver Stripe Dashboard-adgang + CODE REVIEWER/ARCHITECT signoff + pentest-gennemførsel — ikke kode-arbejde. Parker indtil manuelle gates er trigger-klar.')),
    ),
    transition: null,
  },
};

for (const [key, { body, transition }] of Object.entries(perTicket)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  if (transition) {
    const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
    const target = (JSON.parse(tr.body).transitions || []).find(t => new RegExp(`^${transition}$`, 'i').test(t.name));
    if (target) {
      const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
      console.log(r.status === 204 ? `  ✅ ${key} → ${transition}` : `  ⚠️ ${r.status}`);
    }
  } else {
    console.log(`  ◻ ${key} kept in To Do (scope note added)`);
  }
}
