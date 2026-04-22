#!/usr/bin/env node
/**
 * Opretter 2 infra-tickets:
 * 1. Migration drift — test-env ikke managed via supabase_migrations (årsag til RLS-gap på regnskab_cache)
 * 2. Supabase security-advisor cleanup (alle 3 envs har lints)
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

// ─── Ticket 1: Migration drift ────────────────────────────────────
const driftTicket = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    issuetype: { name: 'Task' },
    priority: { name: 'High' },
    summary: 'Migration drift i test-env — supabase_migrations tracking mangler, kan skipe security-migrations',
    labels: ['devops', 'security', 'migrations', 'infrastructure'],
    description: d(
      h(2, 'Formål'),
      p(txt('Test-env ('), code('rlkjmqjxmkxuclehbrnl'), txt(') har ikke '), code('supabase_migrations.schema_migrations'), txt(' schema — migrations applyes manuelt uden tracking. Det betyder at security-migrations kan blive skipped uopdaget, indtil Supabase security-advisor fanger problemet.')),

      h(2, 'Aktuelle symptom (fikset 2026-04-22)'),
      p(txt('Supabase security-advisor sendte email-alert kl. 15:45: "'), strong('Table publicly accessible'), txt('" for '), code('public.regnskab_cache'), txt(' i test-env. Root cause: migration '), code('044_regnskab_cache_rls.sql'), txt(' var ikke kørt mod test-env. Fix applied manuelt via Management API SQL-query — RLS enabled + deny-all policy.')),
      p(strong('Prod og dev var ikke berørt'), txt(' — migration var kørt der. Men vi har ingen garanti for at det vedbliver at være tilfældet ved fremtidige migrations.')),

      h(2, 'Root cause'),
      ul(
        li(p(txt('Test-env er opsat uden Supabase CLI migration-tracking.'))),
        li(p(txt('Manuel apply betyder ingen automatisk detektering af missed migrations.'))),
        li(p(txt('Ingen CI-check sammenligner applied migrations mellem dev/preview/prod.'))),
      ),

      h(2, 'Foreslået fix'),
      ol(
        li(p(strong('Kort sigt — enable tracking: '), txt('opret '), code('supabase_migrations.schema_migrations'), txt(' i test-env. Seed den med alle migrations 001-060 som "applied". Fra nu af kan '), code('supabase db push'), txt(' eller '), code('supabase migration up'), txt(' bruges sikkert.'))),
        li(p(strong('Check drift NU: '), txt('kør alle migrations 001-060 mod test-env med '), code('IF NOT EXISTS'), txt(' / idempotent SQL, så eventuelle andre skipped migrations catches op. Log hver migration der rent faktisk ændrede state.'))),
        li(p(strong('Mellem sigt — CI-check: '), txt('tilføj '), code('.github/workflows/migration-drift.yml'), txt(' der ugentligt sammenligner applied migrations på tværs af envs og alerter på drift.'))),
        li(p(strong('Dokumenter: '), txt('opdater '), code('docs/architecture/DATABASE.md'), txt(' med migration-deployment-procedure for alle 3 environments.'))),
      ),

      h(2, 'Script til drift-check'),
      cb(
`#!/bin/bash
# scripts/check-migration-drift.sh
# Sammenligner applied migrations på tværs af prod/dev/test

TOKEN=$SUPABASE_ACCESS_TOKEN
for ENV in "prod:xsyldjqcntiygrtfcszm" "dev:wkzwxfhyfmvglrqtmebw" "test:rlkjmqjxmkxuclehbrnl"; do
  NAME="\${ENV%%:*}"
  REF="\${ENV##*:}"
  echo "=== $NAME ==="
  curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \\
    -H "Authorization: Bearer $TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"query":"SELECT version FROM supabase_migrations.schema_migrations ORDER BY version"}' \\
    || echo "  (no migration tracking)"
done`,
        'bash'
      ),

      h(2, 'Acceptance'),
      ul(
        li(p(code('supabase_migrations.schema_migrations'), txt(' tabel findes i alle 3 envs.'))),
        li(p(txt('Script '), code('scripts/check-migration-drift.sh'), txt(' eksisterer og kører uden fejl.'))),
        li(p(txt('GitHub Actions workflow kører drift-check mindst ugentligt.'))),
        li(p(txt('Dokumentation opdateret i '), code('docs/architecture/DATABASE.md'), txt('.'))),
        li(p(txt('Test: simulér skipped migration → drift-check fanger den inden for 7 dage.'))),
      ),

      h(2, 'Relateret'),
      p(strong('Reason for discovery: '), txt('Supabase security-advisor email-alert 2026-04-22 15:45 for '), code('regnskab_cache'), txt('.')),
      p(strong('Oprindelig migration: '), code('044_regnskab_cache_rls.sql'), txt(' (BIZZ-378).')),
    ),
  },
});
if (driftTicket.status !== 201) {
  console.error('Drift ticket fail:', driftTicket.status, driftTicket.body.slice(0, 400));
  process.exit(1);
}
const DRIFT_KEY = JSON.parse(driftTicket.body).key;
console.log(`✅ Created ${DRIFT_KEY} — migration drift tracking`);

// ─── Ticket 2: Supabase advisor cleanup ────────────────────────────────
const advisorTicket = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    issuetype: { name: 'Task' },
    priority: { name: 'High' },
    summary: 'Supabase security-advisor cleanup — 34 lints i prod, 20 i dev, 12 i test',
    labels: ['security', 'iso27001', 'database', 'supabase', 'advisor'],
    description: d(
      h(2, 'Formål'),
      p(txt('Supabase security-advisor rapporterer sikkerhedsbemærkninger i alle 3 environments. 1 ERROR-level, flere WARN-level. Skal gennemgås og fikses før næste ISO 27001 review.')),

      h(2, 'Samlet status (2026-04-22)'),
      cb(
`                    ERROR  WARN  INFO  TOTAL
prod                  1     28    5      34
dev                   1     15    4      20
test                  1      7    4      12

Fordelt på type (alle envs):
  security_definer_view          1 (ERROR)  — link_verification_counts
  auth_leaked_password_protection 1 (WARN)   — HaveIBeenPwned check off
  function_search_path_mutable   2-3 (WARN) — set_updated_at, ai_settings_*, tenant.*
  rls_enabled_no_policy          4-5 (INFO) — cursor-tabeller
  rls_policy_always_true         3-25 (WARN) — service-role policies med USING/WITH CHECK true`,
        'text'
      ),

      h(2, 'Issue 1 — security_definer_view (ERROR)'),
      p(txt('View '), code('public.link_verification_counts'), txt(' er defineret som SECURITY DEFINER → bypasser querying users RLS. Skal genoprettes uden SECURITY DEFINER (eller gøres til SECURITY INVOKER eksplicit).')),
      cb(
`-- Fix: recreate view as SECURITY INVOKER (default)
DROP VIEW IF EXISTS public.link_verification_counts;
CREATE VIEW public.link_verification_counts
  WITH (security_invoker = true)  -- eksplicit
  AS SELECT ...;  -- original definition fra migration`,
        'sql'
      ),

      h(2, 'Issue 2 — function_search_path_mutable (WARN)'),
      p(txt('3 trigger-functions har '), code('search_path'), txt(' ikke sat — sikkerhedsrisiko for path hijacking:')),
      ul(
        li(p(code('public.set_updated_at'))),
        li(p(code('public.ai_settings_set_updated_at'))),
        li(p(code('tenant.set_knowledge_updated_at'))),
      ),
      cb(
`-- Fix pr. function
ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.ai_settings_set_updated_at() SET search_path = public;
ALTER FUNCTION tenant.set_knowledge_updated_at() SET search_path = tenant, public;`,
        'sql'
      ),

      h(2, 'Issue 3 — rls_enabled_no_policy (INFO)'),
      p(txt('Cursor-tabeller har RLS enabled men ingen policies → authenticated users får 0 rows (intended) men lint flagger det. Tilføj eksplicit service-role-only policy for klarhed:')),
      ul(
        li(p(code('cvr_aendring_cursor'))),
        li(p(code('cvr_virksomhed'))),
        li(p(code('service_probe_history'))),
        li(p(code('tinglysning_aendring_cursor'))),
      ),
      cb(
`-- Eksempel pattern (anvend på alle 4)
CREATE POLICY "service_role_only" ON public.cvr_virksomhed
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
-- Alt authenticated access blokkes implicit (ingen policy for authenticated role)`,
        'sql'
      ),

      h(2, 'Issue 4 — rls_policy_always_true (WARN)'),
      p(txt('Flere policies bruger '), code('USING (true)'), txt(' eller '), code('WITH CHECK (true)'), txt(' for INSERT/UPDATE/DELETE. Prod har 25 af dem (mest impact).')),
      p(strong('Review-krav: '), txt('for hver policy, bekræft at den faktisk kun kan træffes af service_role (ikke authenticated). Hvis ja: tilføj '), code('TO service_role'), txt(' eksplicit så linten bliver tilfreds. Hvis nej: tighten til faktisk business-logik.')),

      h(2, 'Issue 5 — auth_leaked_password_protection (WARN)'),
      p(txt('HaveIBeenPwned-check er slukket. Aktivér i Supabase dashboard → Auth → Security:')),
      cb(
`Auth Settings:
  ☑ Enable HaveIBeenPwned password protection
  ☑ Min password strength (medium eller stronger)`,
        'text'
      ),
      p(strong('Action: '), txt('gøres i alle 3 environments via Supabase dashboard. 5 min arbejde.')),

      h(2, 'Foreslået rækkefølge'),
      ol(
        li(p(strong('Først (5 min): '), txt('Enable HaveIBeenPwned i alle 3 dashboards.'))),
        li(p(strong('Derefter (30 min): '), txt('Migration '), code('061_supabase_advisor_fixes.sql'), txt(' med: SECURITY DEFINER view recreate + 3 function search_path + 4 cursor-policies.'))),
        li(p(strong('Til sidst (1-2 timer): '), txt('Review '), code('rls_policy_always_true'), txt('-policies — bestemm '), code('TO service_role'), txt('-tightening pr. policy.'))),
      ),

      h(2, 'Acceptance'),
      ul(
        li(p(txt('0 ERROR-level lints i alle 3 environments.'))),
        li(p(txt('0 '), code('function_search_path_mutable'), txt(' WARNs.'))),
        li(p(txt('0 '), code('rls_enabled_no_policy'), txt(' INFOs.'))),
        li(p(code('auth_leaked_password_protection'), txt(' fikset.'))),
        li(p(code('rls_policy_always_true'), txt(': maks 3 accepterede-og-documenterede undtagelser pr. env.'))),
        li(p(txt('Migration '), code('061_supabase_advisor_fixes.sql'), txt(' applied via '), code('BIZZ-XXX migration-drift-fix'), txt(' på alle 3 envs.'))),
      ),

      h(2, 'Discovery'),
      p(txt('Fundet via Supabase Management API '), code('GET /v1/projects/:ref/advisors/security'), txt(' under BIZZ-?? (regnskab_cache) security-advisor fix-session 2026-04-22.')),
    ),
  },
});
if (advisorTicket.status !== 201) {
  console.error('Advisor ticket fail:', advisorTicket.status, advisorTicket.body.slice(0, 400));
  process.exit(1);
}
const ADVISOR_KEY = JSON.parse(advisorTicket.body).key;
console.log(`✅ Created ${ADVISOR_KEY} — supabase advisor cleanup`);

// Link advisor ticket til drift ticket (drift skal løses først så advisor-migration kan tracking'es)
await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key: DRIFT_KEY },
  outwardIssue: { key: ADVISOR_KEY },
});
console.log(`  🔗 ${DRIFT_KEY} relates to ${ADVISOR_KEY}`);

console.log(`\n═══ Done ═══`);
console.log(`  ${DRIFT_KEY} — migration drift tracking`);
console.log(`  ${ADVISOR_KEY} — supabase advisor cleanup (34+20+12 lints)`);
