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

// BIZZ-711 → Done
await postAndTransition('BIZZ-711', doc(
  h(2, 'Code-review — PASS'),
  p(strong('Commit: '), code('9ca4b48'), txt('.')),
  ul(
    li(p(code('app/dashboard/layout.tsx:320-338'), txt(' — hook fetcher '), code('/api/domain/mine'), txt(' KUN når '), code('isDomainFeatureEnabled()'), txt(' er true. Non-fatal failures skjuler menu silent.'))),
    li(p(code('layout.tsx:723-730'), txt(' — conditional render med BEGGE gates: '), code('isDomainFeatureEnabled() && userDomains.length > 0'), txt('.'))),
    li(p(code('DomainNavMenu:1341-1433'), txt(' — single domain → direct '), code('<Link>'), txt(' til '), code('/domain/[id]'), txt('. Multi-domain → collapsible dropdown med count-badge.'))),
    li(p(strong('a11y: '), code('aria-expanded'), txt(', '), code('aria-controls'), txt(' på dropdown. Collapsed sidebar viser icon-only med title-tooltip.'))),
    li(p(strong('Prod-safety: '), txt('menuen renders ALDRIG i prod selvom member-data findes i DB. Network-kald skipped når flag off.'))),
  ),
  p(strong('→ Done.'))
), 'Done');

// BIZZ-712 → Done
await postAndTransition('BIZZ-712', doc(
  h(2, 'Code-review — PASS'),
  p(strong('Commit: '), code('7de7c65'), txt('.')),
  ul(
    li(p(code('app/domain/[id]/layout.tsx:26-30'), txt(' — feature-flag + '), code('resolveDomainId'), txt(' membership-gate. Non-members får 404.'))),
    li(p(code('app/domain/[id]/page.tsx + DomainUserDashboardClient.tsx'), txt(' — cases-liste med debounced search (300ms), status-filter (open/closed/archived/all), status-badges, tags, updated-date, admin-knap conditional, empty state med CTA.'))),
    li(p(code('/api/domain/[id]/cases/route.ts'), txt(' GET: filter status + case-insensitive search på (name + client_ref). POST: Zod-validation (name 1-200, client_ref optional, max 20 tags). Begge kræver '), code('assertDomainMember'), txt('.'))),
    li(p(strong('Audit-log '), txt('ved create_case med metadata (navn, client_ref, tags) til '), code('domain_audit_log'), txt('.'))),
    li(p(code('new-case/NewCaseClient.tsx'), txt(' — form med validering, disable submit før name udfyldt, POST til API, redirect til '), code('/domain/{id}/case/{id}'), txt(' ved success.'))),
  ),
  p(strong('Kvalitet: '), txt('IKKE skeleton-UI — rigtig database-query, validering server-side, audit fires. Feature-gated på hvert layer.')),
  p(strong('→ Done.'))
), 'Done');

// BIZZ-734 → PARTIAL → To Do (blocked af BIZZ-717)
await postAndTransition('BIZZ-734', doc(
  h(2, 'Code-review — PARTIAL (defenses shipped, ikke aktive)'),
  p(strong('Commit: '), code('897b71a'), txt('. Defenses arkitektonisk korrekte + 17 tests passerer, men '), strong('IKKE integreret'), txt(' i production code path fordi BIZZ-717 (generation API) ikke er shipped endnu.')),

  h(3, 'PASS ✅ — Defense-infrastruktur'),
  ul(
    li(p(strong('Lag 1 Strict schema: '), code('app/lib/domainGenerationSchema.ts:34-49'), txt(' — '), code('GenerationOutputSchema'), txt(' med '), code('.strict()'), txt(' afviser ekstra keys. Max 50 sections, 20k chars/body.'))),
    li(p(strong('Lag 2 Suspicious-scanner: '), code('lines 100-130'), txt(' — 6 regex patterns (ignore_instructions, override_prompt, system_prompt_leak, credential_exfil, role_shift, cross_domain_ask). Audit-only, ikke blocking.'))),
    li(p(strong('Lag 3 Guard-suffix: '), code('PROMPT_INJECTION_GUARD_SUFFIX:137-148'), txt(' — 5 regler: JSON-only, no markdown, ignore doc-embedded overrides, no role-shift, unresolved array.'))),
    li(p(strong('17 tests passerer'), txt(' — PI-1 til PI-6: tom/non-string input, schema mismatch, extra keys, code-fence tolerance, suspicious flags, guard-suffix indhold.'))),
  ),

  h(3, 'FAIL ❌ — Defenses ikke kaldt nogen steder'),
  p(txt('Grep finder '), code('parseGenerationOutput()'), txt(' + '), code('scanSuspiciousContent()'), txt(' KUN i test-filen. '), code('PROMPT_INJECTION_GUARD_SUFFIX'), txt(' er ikke appendet til nogen system-prompt. Dette er forventet — BIZZ-717 skal wire det ind — men betyder defenses er '), strong('zero-activation'), txt(' indtil BIZZ-717 shipper.')),

  h(3, 'Hvad der mangler for Done'),
  ul(
    li(p(strong('BIZZ-717 generation API '), txt('implementeret — Claude client-integration + docxtemplater.'))),
    li(p(txt('Wire '), code('PROMPT_INJECTION_GUARD_SUFFIX'), txt(' ind i system-prompt bygningen.'))),
    li(p(txt('Kald '), code('parseGenerationOutput()'), txt(' med Zod-validering før docx-fill.'))),
    li(p(txt('Kald '), code('scanSuspiciousContent()'), txt(' på hvert case-doc upload → audit-log entry når hits.'))),
    li(p(txt('E2E-test: upload malicious case-doc → verify output forbliver struktureret JSON + audit entry skrevet.'))),
    li(p(txt('PI-4 docxtemplater XML/HTML escape — kræver også BIZZ-717.'))),
  ),

  p(strong('Blocker: '), code('BIZZ-717'), txt('. Defenses er ready-to-plug-in — kan ikke ship før pipelinen findes. Keep in To Do for trackability.')),
  p(strong('→ To Do.'))
), 'To Do');

console.log('\nDone.');
