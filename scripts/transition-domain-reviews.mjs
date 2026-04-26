#!/usr/bin/env node
/**
 * Post verification-results + transition domain tickets.
 *   PASS (5): 697, 699, 701, 702, 704 → Done
 *   FAIL/PARTIAL (6): 698, 700, 703, 705, 706, 722 → To Do med specifik mangelliste
 */
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
const ol = (...i) => ({ type: 'orderedList', content: i });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const d = (...b) => ({ type: 'doc', version: 1, content: b });

async function transition(key, statusName) {
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => new RegExp(`^${statusName}$`, 'i').test(x.name));
  if (!t) { console.log(`  ⚠️ ${key}: no "${statusName}" transition (${(JSON.parse(tr.body).transitions || []).map(x => x.name).join(', ')})`); return; }
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
  console.log(r.status === 204 ? `  ✅ ${key} → ${statusName}` : `  ⚠️ ${key} transition ${r.status}`);
}

// ─── PASS tickets → Done ───────────────────────────────────────────
const passTickets = {
  'BIZZ-697': {
    title: 'ADR — design signoff',
    body: d(
      h(2, 'Code-review — PASS'),
      p(strong('Verificeret: '), code('docs/adr/0005-domain-feature.md'), txt(' (commit '), code('23366b4'), txt(').')),
      p(txt('Alle 9 designbeslutninger fra ticket-scope er dækket: Domain vs Tenant (parallel entitet), role-navne (admin/member), template-format (.docx via docxtemplater), embeddings (Voyage AI), docx-fill-library (docxtemplater), generation sync/async, namespace-strategi ('), code('domain_{uuid}'), txt('), case-struktur (flat + tags), retention (24 mdr default, configurable).')),
      p(txt('Ikke superficial — inkluderer implementation-faser, data-isolation-strategi, ISO 27001 A.13-reference og rationale per beslutning.')),
      p(strong('→ Done.'))
    ),
  },
  'BIZZ-699': {
    title: 'Feature flag',
    body: d(
      h(2, 'Code-review — PASS'),
      p(strong('Verificeret: '), code('app/lib/featureFlags.ts'), txt(' + '), code('proxy.ts'), txt(' gate (commit '), code('7577fca'), txt(').')),
      ul(
        li(p(code('isDomainFeatureEnabled()'), txt(' default=false; læser '), code('NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED'), txt('.'))),
        li(p(code('isDomainFeatureEnabledServer()'), txt(' har server-side kill-switch ('), code('DOMAIN_FEATURE_KILL_SWITCH=1'), txt(').'))),
        li(p(code('proxy.ts:122-129'), txt(' returnerer 404 for '), code('/domain/**'), txt(' og '), code('/api/domain/**'), txt(' når flag off.'))),
        li(p(code('/dashboard/admin/domains/page.tsx:17'), txt(' kalder '), code('notFound()'), txt(' hvis disabled.'))),
        li(p(txt('API-routes check flag FØRST ('), code('/api/admin/domains/route.ts:38,92'), txt(', '), code('/api/domain/mine/route.ts:18'), txt(').'))),
      ),
      p(strong('Note: '), txt('Mindre asymmetri — '), code('/dashboard/admin/domains/**'), txt(' er gated på page-niveau (notFound), ikke i proxy.ts. Acceptabel.')),
      p(strong('→ Done.'))
    ),
  },
  'BIZZ-701': {
    title: 'Super-admin UI',
    body: d(
      h(2, 'Code-review — PASS'),
      p(strong('Verificeret: '), code('/dashboard/admin/domains/*'), txt(' + '), code('/api/admin/domains/**'), txt(' (commits '), code('fc9d2a9'), txt(' + '), code('5422c2b'), txt(').')),
      ul(
        li(p(code('page.tsx:27'), txt(' server-side check '), code('app_metadata.isAdmin'), txt('.'))),
        li(p(code('DomainsListClient.tsx'), txt(' viser name, status, member/template/case counts, created date.'))),
        li(p(txt('Suspend/activate (lines 74-91): PATCH '), code('/api/admin/domains/{id}'), txt(' med action.'))),
        li(p(txt('Delete (lines 94-106): DELETE '), code('/api/admin/domains/{id}'), txt('.'))),
        li(p(txt('API-routes gater konsistent med '), code('requireSuperAdmin()'), txt(' som FØRSTE action.'))),
      ),
      p(strong('→ Done.'))
    ),
  },
  'BIZZ-702': {
    title: 'Invite Domain Admin',
    body: d(
      h(2, 'Code-review — PASS'),
      p(strong('Verificeret: '), code('/api/admin/domains/[id]/members/route.ts'), txt(' (commit '), code('6a595ed'), txt(').')),
      ul(
        li(p(txt('Nye brugere: '), code('auth.admin.inviteUserByEmail()'), txt(' (linje 124).'))),
        li(p(txt('Eksisterende brugere: upsert uden invite (linje 141).'))),
        li(p(strong('Email-guard wired: '), code('check_domain_email_guard()'), txt(' RPC (linjer 99-109), bruger whitelist fra BIZZ-722-migration.'))),
        li(p(txt('Audit log-entries for invite + add (linjer 153-160).'))),
        li(p(txt('Role-parameter understøtter både admin og member (linje 92).'))),
      ),
      p(strong('→ Done.'))
    ),
  },
  'BIZZ-704': {
    title: 'Domain admin dashboard',
    body: d(
      h(2, 'Code-review — PASS (med note)'),
      p(strong('Verificeret: '), code('/domain/[id]/admin/*'), txt(' (commit '), code('56bc03e'), txt(').')),
      ul(
        li(p(code('layout.tsx:26'), txt(' kalder '), code('assertDomainAdmin()'), txt(' først; redirect non-admins til /dashboard (linje 28).'))),
        li(p(txt('Dashboard viser 3 KPI-kort: users, templates, cases med counts.'))),
        li(p(txt('Stats loaded via '), code('/api/admin/domains/{id}'), txt('.'))),
        li(p(txt('Sub-nav links til Users/Templates/Training/Settings (linjer 127-154).'))),
      ),
      p(strong('Note: '), txt('AI-usage-30d KPI-kort fra ticket-spec mangler — kan tilføjes i follow-up ticket når AI-pipeline er landed. Ikke blocker da AI-metering først er relevant efter BIZZ-715+.')),
      p(strong('→ Done.'))
    ),
  },
};

// ─── FAIL/PARTIAL tickets → To Do med konkret mangelliste ─────────
const toDoTickets = {
  'BIZZ-698': {
    title: 'DB schema',
    body: d(
      h(2, 'Code-review — FAIL (2 blocking SQL-bugs)'),
      p(strong('Fundet via code-review af '), code('supabase/migrations/058_domain_schema.sql'), txt(' og '), code('059_domain_isolation_hardening.sql'), txt(' — skal fikses før schema kan deployes.')),

      h(3, 'Bug 1 — `domain_suspicious_access` view fejler runtime'),
      cb(
`Fil: supabase/migrations/059_domain_isolation_hardening.sql:23
Nuværende:   SELECT dal.actor_id, ...
Skal være:   SELECT dal.actor_user_id, ...

Schema 058 (linje 154) definerer kolonnen som 'actor_user_id'.
View SELECT fejler → super-admin kan ikke query anomaly detection.`,
        'sql'
      ),

      h(3, 'Bug 2 — match_domain_embeddings RPC fejler runtime'),
      cb(
`Fil: supabase/migrations/059_domain_isolation_hardening.sql:143
Nuværende:   SELECT de.content ...
Skal være:   SELECT de.chunk_text ...

Schema 058 (linje 138) definerer kolonnen som 'chunk_text'.
RPC SELECT fejler → vector search helt brudt (hele AI-pipeline blokeret).`,
        'sql'
      ),

      h(3, 'Hvad der ER OK (check listet for transparens)'),
      ul(
        li(p(txt('Alle 10 tabeller til stede: domain, domain_member, domain_template, domain_template_version, domain_training_doc, domain_case, domain_case_doc, domain_generation, domain_embedding, domain_audit_log.'))),
        li(p(code('is_domain_member()'), txt(' + '), code('is_domain_admin()'), txt(' SECURITY DEFINER helpers korrekte.'))),
        li(p(txt('RLS enabled + policies for alle 10 tabeller.'))),
        li(p(txt('059-migration tilføjer '), code('email_domain_whitelist'), txt(' + '), code('email_domain_enforcement'), txt(' + AI-token-tracking korrekt.'))),
      ),

      h(2, 'Hvad der skal gøres'),
      ol(
        li(p(txt('Opret ny migration '), code('060_fix_domain_schema_column_refs.sql'), txt(' der retter begge view/RPC (IKKE rediger 059 — den er allerede deployet i CI).'))),
        li(p(txt('Verificér ved at køre '), code('EXPLAIN SELECT * FROM domain_suspicious_access'), txt(' og '), code('SELECT * FROM match_domain_embeddings(...)'), txt(' mod lokal dev-DB.'))),
        li(p(txt('Integration-test der inserter testdata i '), code('domain_embedding'), txt(' + '), code('domain_audit_log'), txt(' og queryer gennem view + RPC.'))),
      )
    ),
  },
  'BIZZ-700': {
    title: 'Auth helpers + Storage',
    body: d(
      h(2, 'Code-review — PARTIAL'),
      p(strong('Verificeret: '), code('app/lib/domainAuth.ts'), txt(' + '), code('app/lib/domainStorage.ts'), txt(' (commit '), code('7577fca'), txt(').')),
      h(3, 'OK ✅'),
      ul(
        li(p(txt('Alle 4 funktioner eksporteret: '), code('resolveDomainId'), txt(', '), code('assertDomainAdmin'), txt(', '), code('assertDomainMember'), txt(', '), code('listUserDomains'), txt('.'))),
        li(p(txt('Auth-checks kaster 403 på non-member (linjer 82-84, 98-100).'))),
        li(p(txt('UUID-validering med Zod (linje 44) forhindrer injection.'))),
        li(p(txt('Follow-existing-pattern: '), code('resolveTenantId'), txt(' → '), code('resolveDomainId'), txt(' analogi korrekt.'))),
      ),

      h(3, 'Afvigelse fra spec ⚠'),
      p(strong('Spec bad om 4 buckets: '), code('domain-templates'), txt(', '), code('domain-training'), txt(', '), code('domain-cases'), txt(', '), code('domain-generated'), txt('.')),
      p(strong('Implementation: '), code('domainStorage.ts:19'), txt(' bruger '), strong('1 shared bucket '), code('domain-files'), txt(' med path-baseret isolation ('), code('{domainId}/templates/...'), txt(').')),
      p(strong('Vurdering: '), txt('Funktionelt ækvivalent — RLS + membership-check FØR signed-URL-generation håndhæves begge steder. Path-prefixing giver dog lavere isolation-granularitet ved storage-niveau backup/restore. Kan være OK men matcher ikke spec.')),

      h(2, 'Hvad der mangler'),
      ol(
        li(p(strong('Beslut: '), txt('(a) Accepter 1-bucket-designet + opdater ADR-0005 med begrundelse, eller (b) refactor til 4 separate buckets pr. spec.'))),
        li(p(strong('Hvis (a): '), txt('tilføj comment i '), code('domainStorage.ts'), txt(' + ADR-note om at path-isolation er tilsigtet.'))),
        li(p(strong('Hvis (b): '), txt('opret 3 ekstra Supabase buckets + flyt API-kald til korrekte buckets + RLS policies.'))),
        li(p(strong('Unit-tests mangler: '), txt('ingen '), code('__tests__/domain/auth.test.ts'), txt(' fundet. Tilføj tests for resolveDomainId (non-member → null, member → role, admin-check).'))),
      )
    ),
  },
  'BIZZ-703': {
    title: 'Plan/limits config',
    body: d(
      h(2, 'Code-review — PARTIAL'),
      p(strong('Skemaet er delvist implementeret, men hverken enforcement eller UI er på plads.')),
      h(3, 'OK ✅'),
      ul(
        li(p(txt('Schema (058:16) har '), code('limits jsonb'), txt(' med defaults for '), code('max_users'), txt(', '), code('max_templates'), txt(', '), code('max_tokens_per_month'), txt(', '), code('retention_months'), txt('.'))),
        li(p(txt('API PATCH '), code('/api/admin/domains/[id]'), txt(' (linje 118) accepterer '), code('limits'), txt(' i body.'))),
      ),

      h(3, 'Mangler ❌'),
      ul(
        li(p(strong('UI-komponent: '), txt('ingen editor til at sætte limits; settings-page eksisterer ikke endnu (jf. BIZZ-706).'))),
        li(p(strong('Enforcement: '), txt('ingen code checker '), code('tokens_used'), txt(' mod '), code('max_tokens_per_month'), txt('. Ingen validering af user-count ved invite ('), code('/api/admin/domains/[id]/members/route.ts'), txt(' tjekker ikke '), code('max_users'), txt(').'))),
        li(p(strong('Notification: '), txt('ticket bad om email til Domain Admin ved 80% forbrug — ikke implementeret.'))),
      ),

      h(2, 'Hvad der skal gøres'),
      ol(
        li(p(txt('UI: editor på '), code('/domain/[id]/admin/settings'), txt(' (afhænger af BIZZ-706).'))),
        li(p(txt('Enforcement i '), code('/api/admin/domains/[id]/members/route.ts'), txt(': tjek current member-count mod '), code('limits.max_users'), txt(' før insert.'))),
        li(p(txt('Enforcement i AI-pipeline (BIZZ-715+): '), code('aiGate.assertAiAllowed()'), txt(' udvides med '), code('domain_id'), txt(' + tokens-tracking mod '), code('limits.max_tokens_per_month'), txt('.'))),
        li(p(txt('Cron-job der checker usage > 80% og sender email via Resend.'))),
      )
    ),
  },
  'BIZZ-705': {
    title: 'User management',
    body: d(
      h(2, 'Code-review — PARTIAL (API done, UI missing)'),
      p(strong('API er komplet og fungerer, men der er ingen måde at nå den fra UI.')),
      h(3, 'OK ✅'),
      ul(
        li(p(code('/api/admin/domains/[id]/members/route.ts'), txt(': GET, POST, DELETE alle gater korrekt.'))),
        li(p(txt('GET beriger med user email + fullName (linjer 58-67).'))),
        li(p(txt('Upsert understøtter role-toggle (admin↔member).'))),
        li(p(txt('Audit log entries ved alle mutationer.'))),
      ),

      h(3, 'Mangler ❌'),
      p(strong('Ingen UI-komponent på '), code('/domain/[id]/admin/users'), txt('. Dashboard (BIZZ-704) har "Users"-link men target-siden eksisterer ikke.')),

      h(2, 'Hvad der skal gøres'),
      ol(
        li(p(txt('Opret '), code('app/domain/[id]/admin/users/page.tsx'), txt(' + client component med tabel.'))),
        li(p(txt('Viser: email, rolle, joined_at, last_active, actions (fjern, promover/demover).'))),
        li(p(txt('"Inviter bruger"-modal: email + rolle-valg → POST '), code('/api/admin/domains/[id]/members'), txt('.'))),
        li(p(txt('Respekterer '), code('domain.limits.max_users'), txt(' (afhænger af BIZZ-703 enforcement).'))),
        li(p(txt('Fail-safe: kan ikke fjerne sig selv som sidste admin.'))),
      )
    ),
  },
  'BIZZ-706': {
    title: 'Settings editor',
    body: d(
      h(2, 'Code-review — FAIL (Not Implemented)'),
      p(strong('Intet arbejde på denne ticket er landet endnu.')),
      h(3, 'Fundet'),
      ul(
        li(p(strong('Ingen page: '), code('/domain/[id]/admin/settings/page.tsx'), txt(' eksisterer ikke.'))),
        li(p(strong('Ingen dedicated API: '), txt('kun generic '), code('PATCH /api/admin/domains/[id]'), txt(' (linje 118) som kræver super-admin. Domain Admin kan ikke redigere via denne route.'))),
        li(p(strong('Dashboard-links brudt: '), code('DomainAdminDashboardClient.tsx:95,148-153'), txt(' peger på '), code('/admin/settings'), txt(' men der er 404.'))),
      ),

      h(2, 'Hvad der skal gøres'),
      ol(
        li(p(txt('Opret '), code('PATCH /api/domain/[id]/admin/settings/route.ts'), txt(' der kalder '), code('assertDomainAdmin()'), txt(' (ikke super-admin) og begrænser hvilke felter der kan ændres.'))),
        li(p(txt('Opret '), code('app/domain/[id]/admin/settings/page.tsx'), txt(' med 4 tabs: General (navn, logo, sprog), AI (temp, model, custom-prompt-suffix), Retention, Notifications.'))),
        li(p(txt('Ændringer skal audit-logges.'))),
        li(p(txt('Super-admin-tildelte caps kan ikke overskrides af Domain Admin (UI + API-level enforcement).'))),
      )
    ),
  },
  'BIZZ-722': {
    title: 'Isolation hardening',
    body: d(
      h(2, 'Code-review — FAIL (2 SQL bugs + 1 gap)'),
      p(strong('Næsten alle 8 lag er på plads, men de 2 SQL-bugs fra BIZZ-698 matcher hertil + mangler lint-enforcement.')),

      h(3, 'OK ✅'),
      ul(
        li(p(txt('Migration 059 tilføjer email-whitelist + AI-token-metering.'))),
        li(p(code('check_domain_email_guard()'), txt(' RPC validerer email mod whitelist (linjer 42-78).'))),
        li(p(code('domainScopedQuery()'), txt(' wrapper auto-filter på domain_id.'))),
        li(p(code('domainEmbedding.ts'), txt(' bruger '), code('match_domain_embeddings()'), txt(' RPC (server-side domain-filter).'))),
        li(p(code('domainStorage.ts'), txt(' prefikser paths med '), code('{domain_id}/'), txt('; membership-check FØR signed-URL.'))),
      ),

      h(3, 'Bugs ❌'),
      p(strong('Samme 2 bugs som BIZZ-698 (de deler migration 059):')),
      ul(
        li(p(code('059:23'), txt(' '), code('dal.actor_id'), txt(' skal være '), code('dal.actor_user_id'), txt(' — anomaly-view fejler runtime.'))),
        li(p(code('059:143'), txt(' '), code('de.content'), txt(' skal være '), code('de.chunk_text'), txt(' — '), code('match_domain_embeddings()'), txt(' fejler runtime, hele AI-pipeline bryder sammen.'))),
      ),

      h(3, 'Gaps ⚠'),
      ul(
        li(p(strong('Ingen ESLint-rule '), txt('der forbyder '), code("supabase.from('domain_*')"), txt(' udenfor helpers. Kun kommentar-advarsler i '), code('domainEmbedding.ts'), txt('/'), code('domainScopedQuery.ts'), txt(' — ikke enforceret.'))),
        li(p(strong('Ingen anomaly-detection cron '), txt('der querier '), code('domain_suspicious_access'), txt('. Ticket beskrev daglig cron-job der flagger suspicious patterns.'))),
        li(p(strong('Ingen isolation-testsuite: '), txt('ticket acceptance listede 11 specifikke tests; '), code('__tests__/domain/isolation.test.ts'), txt(' eksisterer ikke.'))),
      ),

      h(2, 'Hvad der skal gøres'),
      ol(
        li(p(txt('Ret begge SQL-bugs i ny migration (jf. BIZZ-698).'))),
        li(p(txt('Tilføj custom ESLint-rule i '), code('eslint.config.mjs'), txt(':'))),
        li(p(cb(
`'no-restricted-syntax': ['error', {
  selector: "CallExpression[callee.object.name='supabase'][callee.property.name='from'][arguments.0.value=/^domain_/]",
  message: 'Use domainScopedQuery() or caseScopedQuery()'
}]`,
          'javascript'
        ))),
        li(p(txt('Opret '), code('app/api/cron/domain-anomalies/route.ts'), txt(' der dagligt querier viewet og sender alert ved hits.'))),
        li(p(txt('Byg '), code('__tests__/domain/isolation.test.ts'), txt(' med alle 11 test-scenarier fra ticket-spec.'))),
      )
    ),
  },
};

// ─── Execute ───────────────────────────────────────────────────────
console.log('═══ PASS tickets → Done ═══');
for (const [key, { body }] of Object.entries(passTickets)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment posted` : `❌ ${key} ${cr.status}`);
  await transition(key, 'Done');
}

console.log('\n═══ FAIL/PARTIAL tickets → To Do ═══');
for (const [key, { body }] of Object.entries(toDoTickets)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment posted` : `❌ ${key} ${cr.status}`);
  await transition(key, 'To Do');
}

console.log('\nDone.');
console.log('  5 PASS → Done: 697, 699, 701, 702, 704');
console.log('  6 back to To Do: 698 (SQL bugs), 700 (1-bucket vs 4), 703 (no UI/enforcement), 705 (no UI), 706 (not impl), 722 (SQL bugs + ESLint + cron + tests)');
