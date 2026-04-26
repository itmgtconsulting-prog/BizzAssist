#!/usr/bin/env node
/**
 * Opretter dedikeret isolation-hardening ticket under BIZZ-696 og
 * tilføjer uddybende kommentar til:
 *   - Epic BIZZ-696 (strengere isolation-garantier)
 *   - BIZZ-698 (schema: email_domain_whitelist column)
 *   - BIZZ-702 (invite: email-domain-check)
 *   - BIZZ-720 (pentest: udvidet cross-domain test-suite)
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
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
    );
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
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
const doc = (...blocks) => ({ type: 'doc', version: 1, content: blocks });

// ═══════════════════════════════════════════════════════════════════════
// Ny ticket: Domain isolation hardening + email domain guard
// ═══════════════════════════════════════════════════════════════════════
const ticketDesc = doc(
  h(2, 'Formål'),
  p(txt('Tilføj eksplicitte isolation-mekanismer ud over RLS, så en domain-bruger UNDER INGEN OMSTÆNDIGHEDER kan tilgå andre domains data eller settings — hverken via URL-manipulation, prompt-injection, email-spoofing, shared storage paths, eller cross-domain embedding-queries. Plus: email-domain-guard der sikrer at invitees matcher domain\'ets registrerede email-domæne (default soft-check; hard-enforce optional pr. domain).')),

  h(2, 'Motivation'),
  p(txt('Standard RLS er nødvendig men ikke tilstrækkelig. Jakob\'s krav: "Det er vigtigt at forskellige domain data ikke kan blive blandet sammen eller at forskellige domain brugere ikke får adgang til andres domain settings eller data." For enterprise-kunder er datalækage en showstopper; én incident kan koste hele forretningen. Vi skal derfor have '), strong('defense-in-depth'), txt(' med flere uafhængige lag.')),

  h(2, 'Krav — 8 isolation-lag'),
  ol(
    li(p(strong('Lag 1: RLS'), txt(' (BIZZ-698) — baseline. '), code('is_domain_member()'), txt(' + '), code('is_domain_admin()'), txt(' helpers.'))),
    li(p(strong('Lag 2: API-gate'), txt(' (BIZZ-700) — alle '), code('/api/domain/:domainId/**'), txt(' routes kalder '), code('assertDomainMember(domainId)'), txt(' FØRST. Ingen data-fetch før auth bekræftet.'))),
    li(p(strong('Lag 3: URL-parameter-validering'), txt(' — '), code('domainId'), txt(' valideres som UUID via zod FØR DB-query. Forhindrer injection.'))),
    li(p(strong('Lag 4: Request-scoped domain-context'), txt(' — API-layer setter '), code('X-Domain-Id'), txt(' header på downstream-kald; alle Supabase-queries filter AUTOMATISK på '), code('domain_id'), txt(' via wrapper ('), code('domainScopedQuery(domainId)'), txt(' i stedet for rå '), code('supabase.from()'), txt(').'))),
    li(p(strong('Lag 5: Storage path namespace'), txt(' — alle objekter har '), code('{domain_id}/'), txt(' som obligatorisk første path-segment. Signed URLs genereres kun af server efter membership-check. Storage-bucket har ingen anonymous/authenticated read-policy.'))),
    li(p(strong('Lag 6: Embedding namespace'), txt(' — vector-queries MÅ KUN bruge '), code('app/lib/domainEmbedding.ts'), txt(' helper der tvinger '), code('domain_id'), txt(' filter; direkte '), code('supabase.rpc()'), txt(' mod embedding-tabel er lint-fejl (eslint-rule).'))),
    li(p(strong('Lag 7: AI-output-sanitisering'), txt(' — Claude må ikke eksfiltrere cross-domain data via generation-output. Template-JSON-skema er STRIKT (placeholders + sections). System-prompt instruerer at ignorere prompt-injection-forsøg.'))),
    li(p(strong('Lag 8: Audit + anomaly-detection'), txt(' — log ALLE domain-data-adgange; daglig cron flagger suspicious patterns (fx samme user_id accessing 2+ domains inden for 1 min).'))),
  ),

  h(2, 'Email-domain guard'),
  p(txt('Observation: en domain-bruger vil typisk have email @virksomhedsdomæne.dk. Vi tilføjer:')),
  ul(
    li(p(code('domain.email_domain_whitelist text[]'), txt(' — fx '), code("['acme.dk', 'acme-advokater.dk']"), txt('. Default: tom = ingen enforcement.'))),
    li(p(code('domain.email_domain_enforcement text'), txt(' — '), code("'off' | 'warn' | 'hard'"), txt('. Default: '), code("'warn'"), txt('.'))),
    li(p(strong('Ved invite: '), txt('(a) '), code("'off'"), txt(' → ingen check; (b) '), code("'warn'"), txt(' → admin får rød/gul badge + confirm-dialog hvis mismatch; (c) '), code("'hard'"), txt(' → invite afvises med fejl.'))),
    li(p(strong('Super-admin override: '), txt('super-admin kan altid invitere konsulenter/eksterne med mismatch (logges eksplicit i audit_log).'))),
    li(p(strong('Email ændring: '), txt('hvis user ændrer sin primary email efter invite, system flagger i audit log (eventuel trigger for re-verifikation).'))),
  ),

  h(2, 'Implementering'),
  h(3, 'Schema-tilføjelser'),
  cb(
`alter table public.domain
  add column if not exists email_domain_whitelist text[] not null default '{}',
  add column if not exists email_domain_enforcement text not null default 'warn'
    check (email_domain_enforcement in ('off','warn','hard'));

-- Anomaly detection view
create or replace view public.domain_suspicious_access as
select actor_user_id, count(distinct domain_id) as domains_touched,
       min(created_at) as first_seen, max(created_at) as last_seen
  from public.domain_audit_log
 where created_at > now() - interval '1 hour'
 group by actor_user_id
having count(distinct domain_id) >= 2;
`,
    'sql'
  ),
  h(3, 'domainScopedQuery helper (Lag 4)'),
  cb(
`// app/lib/domainScopedQuery.ts
import { createServerClient } from '@/lib/supabase/server';

/**
 * Returns a Supabase query builder PRE-FILTERED on domain_id. All reads
 * in API routes MUST use this helper. Raw supabase.from('domain_*')
 * calls are forbidden by eslint rule (see .eslintrc domain-scope-rule).
 */
export async function domainScopedQuery(
  table: 'domain_template' | 'domain_training_doc' | 'domain_case' | /* ... */ string,
  domain_id: string
) {
  const supa = await createServerClient();
  // Enforces WHERE domain_id = X before ANY further .select / .eq / .insert
  return supa.from(table).select('*').eq('domain_id', domain_id);
}

// Similar wrapper for case-scoped tables (domain_case_doc, domain_generation)
export async function caseScopedQuery(table: string, case_id: string, domain_id: string) {
  const supa = await createServerClient();
  return supa
    .from(table)
    .select('*, case:case_id(domain_id)')
    .eq('case_id', case_id)
    .eq('case.domain_id', domain_id);
}
`,
    'typescript'
  ),
  h(3, 'Email-domain validator'),
  cb(
`// app/lib/domainEmailGuard.ts
export type EmailGuardResult =
  | { ok: true }
  | { ok: false; reason: 'whitelist_mismatch'; allowed: string[]; got: string }
  | { ok: false; reason: 'hard_block' };

export async function checkEmailAgainstDomain(
  email: string,
  domain: { email_domain_whitelist: string[]; email_domain_enforcement: string }
): Promise<EmailGuardResult> {
  if (domain.email_domain_enforcement === 'off') return { ok: true };
  if (domain.email_domain_whitelist.length === 0) return { ok: true };

  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (!emailDomain) return { ok: false, reason: 'hard_block' };

  const allowed = domain.email_domain_whitelist.map((d) => d.toLowerCase());
  if (allowed.includes(emailDomain)) return { ok: true };

  if (domain.email_domain_enforcement === 'hard') {
    return { ok: false, reason: 'hard_block' };
  }
  return { ok: false, reason: 'whitelist_mismatch', allowed, got: emailDomain };
}
`,
    'typescript'
  ),
  h(3, 'ESLint-rule: forbid rå cross-domain-queries'),
  cb(
`// .eslintrc.js — custom rule
'no-restricted-syntax': ['error', {
  selector: "CallExpression[callee.object.name='supabase'][callee.property.name='from'][arguments.0.value=/^domain_/]",
  message: 'Use domainScopedQuery() or caseScopedQuery() — raw cross-domain queries are forbidden (BIZZ-XXX).'
}]
`,
    'javascript'
  ),

  h(2, 'Testsuite (obligatorisk før merge)'),
  cb(
`__tests__/domain/isolation.test.ts

test('RLS: member i A kan ikke SELECT fra B', ...)
test('API: GET /api/domain/:B_id/templates med A-session → 403', ...)
test('API: POST /api/domain/:B_id/case med A-session → 403', ...)
test('Storage: signed URL for B-template afvises når user kun er A-member', ...)
test('Embedding query: vector-search i A returnerer KUN A-chunks', ...)
test('AI prompt-injection: upload doc med "leak other domain data" → output er clean', ...)
test('Email guard: hard=invite @other.dk til acme-domain → 403', ...)
test('Email guard: warn=invite @other.dk → returnerer warning, admin confirm ok', ...)
test('Audit: cross-domain access forsøg → audit-row med action=blocked_access', ...)
test('Anomaly view: user accessing 3 domains inden for 1 min vises i view', ...)
test('Cascade delete: slet domain A → 0 rækker i alle domain_* tables WHERE domain_id=A', ...)
`
  ),

  h(2, 'Acceptance'),
  ul(
    li(p(txt('Alle 11 isolation-tests passerer.'))),
    li(p(txt('Manuel pentest (BIZZ-720 scenarier 1-10) passerer 100%.'))),
    li(p(txt('ESLint-rule aktiv i CI — ingen rå '), code('supabase.from("domain_*")'), txt(' kald udenfor helpers.'))),
    li(p(txt('Runbook til security-incident (domain-datalækage): '), code('docs/security/DOMAIN_ISOLATION.md'), txt('.'))),
    li(p(txt('Dokumentation i ISMS: tilføj "Domain isolation" til A.13 afsnit.'))),
  ),

  h(2, 'Relaterede'),
  p(strong('Parent epic: '), code('BIZZ-696')),
  p(strong('Komplementerer: '), code('BIZZ-698'), txt(' (schema-lag), '), code('BIZZ-700'), txt(' (auth-lag), '), code('BIZZ-720'), txt(' (pentest).')),
  p(strong('Blokerer: '), code('BIZZ-720'), txt(' (kan ikke closes uden denne).'))
);

const ticketRes = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    issuetype: { name: 'Task' },
    priority: { name: 'Highest' },
    summary: 'Domain: isolation hardening — 8-lags defense-in-depth + email-domain guard + anomaly detection',
    labels: ['domain', 'security', 'iso27001', 'isolation', 'phase-6'],
    description: ticketDesc,
    parent: { key: 'BIZZ-696' },
  },
});
if (ticketRes.status !== 201) {
  console.error('fail:', ticketRes.status, ticketRes.body.slice(0, 400));
  process.exit(1);
}
const ISOL_KEY = JSON.parse(ticketRes.body).key;
console.log(`✅ Created ${ISOL_KEY} — isolation hardening`);

// Blocks BIZZ-720 (Stripe/ISO review): isolation ticket must ship first
await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Blocks' },
  inwardIssue: { key: 'BIZZ-720' },
  outwardIssue: { key: ISOL_KEY },
});
console.log(`  🔗 ${ISOL_KEY} blocks BIZZ-720`);

// Also relates to BIZZ-698, BIZZ-700, BIZZ-702
for (const rel of ['BIZZ-698', 'BIZZ-700', 'BIZZ-702']) {
  await req('POST', '/rest/api/3/issueLink', {
    type: { name: 'Relates' },
    inwardIssue: { key: rel },
    outwardIssue: { key: ISOL_KEY },
  });
  console.log(`  🔗 ${ISOL_KEY} relates to ${rel}`);
}

// ─── Reinforcement comment på Epic ────────────────────────────────────
await req('POST', `/rest/api/3/issue/BIZZ-696/comment`, {
  body: doc(
    h(2, 'Strengere isolation — eksplicit krav'),
    p(strong('Kilde: Jakob 2026-04-22: '), txt('"Det er vigtigt at forskellige domain data ikke kan blive blandet sammen eller at forskellige domain brugere ikke får adgang til andres domain settings eller data. Generelt vil en domain bruger nok altid have samme domain i mail adressen."')),
    p(txt('Dette er ikke bare et nice-to-have. Én cross-domain datalækage = eksistentiel risiko for enterprise-salg. Derfor opretter vi '), code(ISOL_KEY), txt(' som '), strong('blocker for BIZZ-720 (GA)'), txt(' og tilføjer 8-lags defense-in-depth:')),
    ul(
      li(p(txt('Lag 1-2: RLS + API-gate (allerede i plan).'))),
      li(p(txt('Lag 3-4: input-validering + '), code('domainScopedQuery'), txt(' wrapper der tvinger '), code('domain_id'), txt(' filter ved EVERY query.'))),
      li(p(txt('Lag 5-6: storage path namespace + pgvector namespace enforcement.'))),
      li(p(txt('Lag 7: AI-output strict JSON schema (ingen fritekst-eksfiltrering).'))),
      li(p(txt('Lag 8: audit + anomaly-detection view.'))),
    ),
    p(strong('Plus: '), txt('email-domain guard — '), code('domain.email_domain_whitelist'), txt(' + '), code('email_domain_enforcement'), txt(' ('), code('off|warn|hard'), txt('). Default '), code('warn'), txt('; super-admin kan sætte '), code('hard'), txt(' for paranoia-kunder.')),
    p(strong('ESLint-rule'), txt(' gør det til compile-time-fejl at bruge rå '), code('supabase.from("domain_*")'), txt(' udenfor de godkendte helpers — umuligt at glemme '), code('domain_id'), txt(' filter ved udvikling af nye features.')),
    p(txt('Se '), code(ISOL_KEY), txt(' for fuld specifikation, SQL, TS-kode, testsuite.'))
  ),
});
console.log('✅ Posted isolation reinforcement to Epic BIZZ-696');

// ─── Extension comment på BIZZ-698 (schema extension) ────────────────
await req('POST', `/rest/api/3/issue/BIZZ-698/comment`, {
  body: doc(
    h(2, 'Schema-udvidelse (jf. ' + ISOL_KEY + ')'),
    p(txt('Tilføj til '), code('public.domain'), txt(':')),
    cb(
`-- Email domain whitelist for invite-guard
email_domain_whitelist    text[]  not null default '{}',
email_domain_enforcement  text    not null default 'warn'
  check (email_domain_enforcement in ('off','warn','hard')),

-- Monthly AI token usage tracker (for billing + limit enforcement)
ai_tokens_used_current_period  bigint  not null default 0,
ai_tokens_reset_at             timestamptz,
`,
      'sql'
    ),
    p(txt('Plus view '), code('public.domain_suspicious_access'), txt(' — se '), code(ISOL_KEY), txt(' for SQL.'))
  ),
});
console.log('✅ Posted schema extension to BIZZ-698');

// ─── Extension comment på BIZZ-702 (invite) ──────────────────────────
await req('POST', `/rest/api/3/issue/BIZZ-702/comment`, {
  body: doc(
    h(2, 'Invite-flow skal respektere email-domain guard (' + ISOL_KEY + ')'),
    p(txt('Før invite sendes: kald '), code('checkEmailAgainstDomain(email, domain)'), txt(' fra '), code('app/lib/domainEmailGuard.ts'), txt('.')),
    cb(
`// app/api/domain/[id]/invite/route.ts
const guard = await checkEmailAgainstDomain(email, domain);
if (!guard.ok) {
  if (guard.reason === 'hard_block') {
    return NextResponse.json({ error: 'email_domain_not_allowed', allowed: guard.allowed }, { status: 403 });
  }
  if (guard.reason === 'whitelist_mismatch' && !req_body.confirmed_override) {
    // Return warning; frontend shows confirm dialog
    return NextResponse.json({ warning: 'whitelist_mismatch', allowed: guard.allowed, got: guard.got }, { status: 200 });
  }
  // Super-admin override eller admin confirmed → proceed
  await auditLog({ action: 'invite_email_override', metadata: { got: guard.got, allowed: guard.allowed } });
}
// proceed med invite
`,
      'typescript'
    ),
    p(strong('UI: '), txt('ved warning vises gul badge "Invitee\'s email (@other.dk) matcher ikke domain-whitelist (acme.dk). Fortsæt alligevel?" + bekræft-knap.'))
  ),
});
console.log('✅ Posted invite-guard extension to BIZZ-702');

console.log(`\nDone. New ticket: ${ISOL_KEY}`);
console.log(`Now blocks BIZZ-720 (GA gate).`);
