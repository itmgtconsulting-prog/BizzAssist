#!/usr/bin/env node
/**
 * Post verification + transition:
 *   PASS (5): 698, 700, 703, 705, 706 → Done
 *   PARTIAL (1): 722 → To Do (test coverage 8/11)
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
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const d = (...b) => ({ type: 'doc', version: 1, content: b });

async function postAndTransition(key, body, target) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment posted` : `❌ ${key} comment ${cr.status} ${cr.body.slice(0, 200)}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => new RegExp(`^${target}$`, 'i').test(x.name));
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → ${target}` : `  ⚠️ ${r.status}`);
  }
}

// ── PASS → Done ──────────────────────────────────────────────────────
await postAndTransition('BIZZ-698', d(
  h(2, 'Re-review — PASS'),
  p(strong('Commit '), code('980c991'), txt(' fikser begge SQL-bugs i ny migration '), code('060_fix_domain_schema_column_refs.sql'), txt('.')),
  ul(
    li(p(strong('Bug 1 fikset: '), code('domain_suspicious_access'), txt(' view (060:13-30) DROP+CREATE med korrekt '), code('dal.actor_user_id'), txt('. Verificeret mod 058:151.'))),
    li(p(strong('Bug 2 fikset: '), code('match_domain_embeddings'), txt(' RPC (060:35-72) aliaser '), code('de.chunk_text AS content'), txt('. Verificeret mod 058:138.'))),
    li(p(strong('Isolation bevaret: '), code('WHERE de.domain_id = p_domain_id'), txt(' er stadig obligatorisk i RPC (Lag 6).'))),
  ),
  p(strong('→ Done.'))
), 'Done');

await postAndTransition('BIZZ-700', d(
  h(2, 'Re-review — PASS'),
  ul(
    li(p(code('__tests__/domain/auth.test.ts'), txt(' (162 linjer) dækker alle 4 helpers: '), code('resolveDomainId'), txt(' (null på bad UUID uden DB-kald, null på non-member, context for member/admin), '), code('assertDomainAdmin'), txt(' (403 for member), '), code('assertDomainMember'), txt(' (rejects malformed UUID).'))),
    li(p(strong('Defense-in-depth verificeret: '), txt('tests bekræfter at DB '), strong('ikke'), txt(' kaldes ved malformed UUID — Lag 3 (input-validering) virker.'))),
    li(p(code('docs/adr/0005-domain-feature.md'), txt(' (lines 245-255) opdateret med 1-bucket-design-beslutning: app-layer RLS + membership-check før signed-URL + path-namespace guard. Trade-off (backup-granularitet) dokumenteret.'))),
  ),
  p(strong('→ Done.'))
), 'Done');

await postAndTransition('BIZZ-703', d(
  h(2, 'Re-review — PASS'),
  p(strong('Max-users enforcement implementeret: ')),
  ul(
    li(p(code('/api/domain/[id]/admin/members/route.ts'), txt(' linjer 101-122 henter '), code('domain.limits.max_users'), txt(' (default 50) + count current members + returnerer 403 hvis cap nået.'))),
    li(p(txt('Kun på POST (invite) — ikke PATCH/DELETE. Korrekt scope.'))),
    li(p(strong('Dansk fejlbesked: '), code('"Maksimalt antal brugere (${maxUsers}) nået for dette domain"'), txt('.'))),
  ),
  p(strong('Note: '), txt('token-cap + notification-cron er deferred til AI-pipeline (BIZZ-715+) hvor det giver mening i kontekst.')),
  p(strong('→ Done.'))
), 'Done');

await postAndTransition('BIZZ-705', d(
  h(2, 'Re-review — PASS'),
  ul(
    li(p(code('/app/domain/[id]/admin/users/page.tsx'), txt(' + '), code('DomainUsersClient.tsx'), txt(' (298 linjer) komplet.'))),
    li(p(txt('Tabel: email, navn, rolle, joined_at, actions. Invite-modal + role-toggle + remove.'))),
    li(p(strong('Fail-safe: '), txt('route DELETE (linjer 291-314) blokerer fjernelse af sidste admin — tjekker '), code('adminCount <= 1'), txt(', returnerer 400 "Kan ikke fjerne sidste admin".'))),
    li(p(strong('Scope-separation: '), code('/api/domain/[id]/admin/members'), txt(' (domain-admin) vs '), code('/api/admin/domains/[id]/members'), txt(' (super-admin) korrekt adskilt.'))),
    li(p(strong('Respekterer '), code('domain.limits.max_users'), txt(' via BIZZ-703 enforcement.'))),
  ),
  p(strong('→ Done.'))
), 'Done');

await postAndTransition('BIZZ-706', d(
  h(2, 'Re-review — PASS'),
  ul(
    li(p(code('/app/domain/[id]/admin/settings/page.tsx'), txt(' + '), code('DomainSettingsClient.tsx'), txt(' (311 linjer) med 4 tabs: General, AI, Retention (read-only), Isolation.'))),
    li(p(code('/api/domain/[id]/admin/settings/route.ts'), txt(' (145 linjer) — GET+PATCH med '), code('assertDomainAdmin'), txt(' FØRST (linjer 44, 86).'))),
    li(p(strong('Whitelist af editable felter '), txt('(linjer 25-30): '), code('name'), txt(', '), code('settings'), txt(', '), code('email_domain_whitelist'), txt(', '), code('email_domain_enforcement'), txt(' — '), strong('limits/plan/retention IKKE editable'), txt(' af Domain Admin (super-admin-caps respekteret).'))),
    li(p(strong('Audit-log: '), txt('linjer 134-141 inserter til '), code('domain_audit_log'), txt(' med action='), code('update_settings'), txt(' + liste af modificerede felter.'))),
    li(p(strong('Feature-flag gated '), txt('via layout.tsx:21.'))),
  ),
  p(strong('→ Done.'))
), 'Done');

// ── PARTIAL → To Do ───────────────────────────────────────────────────
await postAndTransition('BIZZ-722', d(
  h(2, 'Re-review — PARTIAL (test coverage mangler)'),
  p(strong('SQL + ESLint + cron er produktionsklar. Test-suite dækker 8 ud af 11 krævede scenarier.')),

  h(3, 'PASS ✅'),
  ul(
    li(p(strong('SQL bugs fikset: '), txt('migration 060 retter både view + RPC (samme som BIZZ-698).'))),
    li(p(code('eslint.config.mjs'), txt(' linjer 44-51: '), code('no-restricted-syntax'), txt(' forbyder '), code("supabase.from('domain_*')"), txt(' udenfor whitelistede helpers (domainScopedQuery, domainEmbedding, domainStorage, domainAuth, admin-APIs, cron, tests).'))),
    li(p(code('/api/cron/domain-anomalies/route.ts'), txt(' (162 linjer): '), code('verifyCronSecret'), txt(' bearer-token-check, queryer '), code('domain_suspicious_access'), txt(', sender Resend-email ved hits.'))),
    li(p(code('vercel.json:60-62'), txt(' schedule "45 4 * * *" dagligt 4:45.'))),
  ),

  h(3, 'Testsuite-dækning — 8/11 ❌'),
  p(strong('Fundet i '), code('__tests__/domain/isolation.test.ts'), txt(':')),
  cb(
`DÆKKET (8):
  ✓ Lag 3 (UUID injection) — auth.test.ts:54-62
  ✓ Lag 4 (domainScopedQuery filter) — isolation.test.ts:108-130
  ✓ Lag 5 (storage path rejection) — isolation.test.ts:133-156
  ✓ Lag 6 (embedding RPC domain_id) — isolation.test.ts:159-180
  ✓ Lag 8 (email guard smoke-check) — isolation.test.ts:183-201
  + 3 trivielle/utility-tests

MANGLER (3 kritiske):
  ❌ RLS cross-domain READ/WRITE — kommentar siger "separate E2E suite"
     men E2E er ikke oprettet. RLS er vores bundlag — skal testes.
  ❌ Prompt-injection guard — upload-doc med malicious prompt,
     verificér Claude-output er struktureret JSON uden eksfiltrering.
  ❌ Email guard enforcement-toggle — kun RPC signatur testet.
     Mangler tests der toggler off/warn/hard og verificerer adfærd.
  (Cascade delete ikke testet heller — mindre kritisk, kan være i retention-ticket.)`,
    'text'
  ),

  h(2, 'Hvad der mangler før Done'),
  ul(
    li(p(strong('Tilføj RLS cross-domain tests '), txt('i '), code('isolation.test.ts'), txt(' — integration-test mod lokal Supabase der inserter 2 domains + 1 user som member i A, forsøger at SELECT fra B. Forventet: 0 rows.'))),
    li(p(strong('Tilføj prompt-injection test '), txt('— mock Claude-kald med malicious case-doc, verificér output matcher JSON-schema og ingen cross-domain data i felterne.'))),
    li(p(strong('Tilføj email-guard toggle-tests '), txt('— for hver '), code('enforcement'), txt('-værdi (off/warn/hard) + forskellige whitelist-konfigurationer. Verificér 200/warn/403.'))),
    li(p(strong('Alternativ: '), txt('split remaining tests til ny ticket '), code('BIZZ-XXX'), txt(' "Isolation E2E-suite" hvis de kræver live Supabase + er for tunge til unit-suite. Sig til hvis du vil have den oprettet.'))),
  )
), 'To Do');

console.log('\n═══ Done ═══');
console.log('  5 PASS → Done: 698, 700, 703, 705, 706');
console.log('  1 PARTIAL → To Do: 722 (mangler RLS + prompt-injection + email-guard toggle tests)');
