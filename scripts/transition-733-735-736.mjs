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
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

async function postAndTransition(key, body, target) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => new RegExp(`^${target}$`, 'i').test(x.name));
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → ${target}` : `  ⚠️ ${r.status}`);
  }
}

// BIZZ-735 → Done
await postAndTransition('BIZZ-735', doc(
  h(2, 'Code-review — PASS (5/5 acceptance)'),
  p(strong('Commit: '), code('5c9c88d'), txt('.')),
  ul(
    li(p(code('scripts/seed-migration-tracking.mjs'), txt(' — opretter '), code('supabase_migrations.schema_migrations'), txt(' via Management API hvis mangler, backfiller 001-060 (ON CONFLICT DO NOTHING). Håndterer test-env-from-scratch, dev-partial-backfill, prod.'))),
    li(p(code('scripts/check-migration-drift.mjs'), txt(' — querier alle 3 envs via '), code('POST /v1/projects/{ref}/database/query'), txt('. Sammenligner med lokale filer. Exit 1 ved drift (failing CI).'))),
    li(p(code('.github/workflows/migration-drift.yml'), txt(' — cron '), code('0 6 * * 1'), txt(' (mandag 06:00 UTC), injicerer '), code('SUPABASE_ACCESS_TOKEN'), txt(' fra secrets.'))),
    li(p(code('docs/architecture/DATABASE.md'), txt(' — 255 linjer. Per-env project refs (linje 216-220), Management API apply recipe (222-241), drift check CI (243-247), BIZZ-735 incident-context (249-255).'))),
    li(p(strong('Root cause-incident dokumenteret '), txt('— præcedens for fremtidig migration-drift-detektering.'))),
  ),
  p(strong('→ Done.'))
), 'Done');

// BIZZ-736 → Done
await postAndTransition('BIZZ-736', doc(
  h(2, 'Code-review — PASS (5/5 acceptance)'),
  p(strong('Commit: '), code('3600181'), txt('. 3 migrations: '), code('061_supabase_advisor_fixes.sql'), txt(', '), code('062_tenant_policy_tightening.sql'), txt(', '), code('063_remaining_advisor_fixes.sql'), txt('.')),
  ul(
    li(p(strong('security_definer_view (ERROR): '), code('061:14-29'), txt(' recreater '), code('link_verification_counts'), txt(' med '), code('WITH (security_invoker = true)'), txt(' eksplicit.'))),
    li(p(strong('function_search_path_mutable (WARN x3): '), code('061:35-50'), txt(' alter 3 functions ('), code('public.set_updated_at'), txt(', '), code('public.ai_settings_set_updated_at'), txt(', '), code('tenant.set_knowledge_updated_at'), txt(') med '), code('SET search_path'), txt('.'))),
    li(p(strong('rls_enabled_no_policy (INFO x5): '), code('061:57-69'), txt(' tilføjer service-role-only policy på '), code('cvr_aendring_cursor'), txt(', '), code('cvr_virksomhed'), txt(', '), code('service_probe_history'), txt(', '), code('tinglysning_aendring_cursor'), txt(' + '), code('regnskab_cache'), txt(' (symmetri).'))),
    li(p(strong('rls_policy_always_true (WARN x25): '), txt('061 (3 public tables) + 062 (tenant_* schemas loop via pg_namespace) + 063 (property_snapshots variants). Metodisk 3-migrations-approach med documenterede trade-offs.'))),
    li(p(strong('auth_leaked_password_protection: '), txt('out-of-scope for code (Dashboard-only toggle). Correctly excluded fra migrations — commit-besked dokumenterer manual action per env.'))),
  ),
  p(strong('Kvalitetstjek: '), txt('alle migrations idempotente ('), code('DROP IF EXISTS'), txt(' + '), code('CREATE IF NOT EXISTS'), txt('). Policy-loop (062:18-52) bruger '), code('pg_namespace'), txt(' korrekt. Apply-script håndterer partial re-runs.')),
  p(strong('→ Done.'))
), 'Done');

// BIZZ-733 → PARTIAL → To Do
await postAndTransition('BIZZ-733', doc(
  h(2, 'Code-review — PARTIAL (8/12 scenarier)'),
  p(strong('Commit: '), code('03dcd00'), txt('. Fil: '), code('__tests__/domain/isolation.integration.test.ts'), txt(' (186 linjer).')),

  h(3, 'PASS ✅ — B1-B6 email-guard enforcement-toggle'),
  ul(
    li(p(strong('Real integration-tests '), txt('mod test-env ('), code('rlkjmqjxmkxuclehbrnl.supabase.co'), txt(') med service_role key — '), strong('ikke mocked'), txt('.'))),
    li(p(code('B1:75-79'), txt(' enforcement=off → allowed.'))),
    li(p(code('B2:81-86'), txt(' warn + mismatch → allowed med warning.'))),
    li(p(code('B3:88-93'), txt(' warn + match → allowed uden warning.'))),
    li(p(code('B4:95-100'), txt(' hard + mismatch → blocked.'))),
    li(p(code('B5:102-106'), txt(' hard + match → allowed.'))),
    li(p(code('B6:108-112'), txt(' tom whitelist + hard → no enforcement.'))),
    li(p(txt('Setup/teardown '), code('beforeAll/afterAll'), txt(' seeder fikstures korrekt (linje 44-64).'))),
  ),

  h(3, 'PASS ✅ — Policy-contract checks'),
  ul(
    li(p(code('136-152'), txt(' verificerer '), code('relrowsecurity=true'), txt(' på alle '), code('domain_*'), txt(' tables.'))),
    li(p(code('154-165'), txt(' kalder '), code('is_domain_member()'), txt(' + '), code('is_domain_admin()'), txt(' RPC helpers.'))),
  ),

  h(3, 'FAIL ❌ — A1-A6 cross-domain RLS ikke implementeret'),
  cb(
`Fil: isolation.integration.test.ts:174-186
  describe.skip('A1-A6 cross-domain RLS runtime', () => {
    // TODO: requires authenticated JWT for user-A and user-B
    it('A1: SELECT cross-domain returns 0 rows', () => {});
    it('A2: INSERT cross-domain rejected', () => {});
    it('A3: UPDATE cross-domain 0 rows', () => {});
    it('A4: DELETE cross-domain 0 rows', () => {});
    it('A5: Inherited RLS via case.domain_id', () => {});
    it('A6: Admin scoped to own domain', () => {});
  });

KUN scaffolding — alle bodies er () => {} eller TODO-kommentarer.`,
    'typescript'
  ),
  p(strong('Kritisk: '), txt('RLS enforcement kan KUN testes med real authenticated clients — det er hele pointen med RLS. "Policy-contract" (checker at RLS er enabled + helpers findes) beviser INGEN runtime-isolation. Dette var kerne-ticket-kravet.')),

  h(3, 'Hvad der mangler for Done'),
  ul(
    li(p(strong('Opret 2 auth-JWT\'s '), txt('i beforeAll — user-A (member af domain-A) og user-B (member af domain-B) via Supabase auth.'))),
    li(p(strong('Build 2 authenticated clients '), txt('med '), code('createClient(url, anon_key, { global: { headers: { Authorization: \'Bearer JWT\' } } })'), txt('.'))),
    li(p(strong('Implementer A1-A6 bodies '), txt('med rigtige SELECT/INSERT/UPDATE/DELETE-statements via user-A-client mod domain-B-rækker. Forvent 0 rows / RLS reject.'))),
    li(p(strong('A5 inherited RLS: '), txt('særligt vigtig — '), code('domain_case_doc'), txt(' via JOIN på '), code('domain_case.domain_id'), txt('.'))),
    li(p(strong('A6 admin scope: '), txt('user-A som admin af domain-A må STADIG ikke SELECTe domain-B.'))),
  ),

  p(strong('→ Tilbage til To Do. '), txt('B-serien (email-guard) er valid — den er blot ikke tilstrækkelig til at dække ticket-scope. A-serien er lige så kritisk for ISO 27001 isolation-garantier.'))
), 'To Do');

console.log('\nDone.');
