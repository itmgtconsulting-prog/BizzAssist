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

const body = {
  type: 'doc', version: 1, content: [
    h(2, 'Code-review — FAIL (2 SQL bugs + 3 gaps)'),
    p(strong('Næsten alle 8 lag er på plads, men 2 kritiske SQL-bugs + ingen lint-enforcement + ingen anomaly cron + ingen tests.')),

    h(3, 'OK'),
    ul(
      li(p(txt('Migration 059 tilføjer email-whitelist + AI-token-metering.'))),
      li(p(code('check_domain_email_guard()'), txt(' RPC validerer email mod whitelist (059:42-78).'))),
      li(p(code('domainScopedQuery()'), txt(' wrapper auto-filter på domain_id.'))),
      li(p(code('domainEmbedding.ts'), txt(' bruger '), code('match_domain_embeddings()'), txt(' RPC (server-side domain-filter).'))),
      li(p(code('domainStorage.ts'), txt(' prefikser paths med '), code('{domain_id}/'), txt(' og tjekker membership FØR signed-URL.'))),
    ),

    h(3, 'Bug 1 — anomaly-view fejler runtime'),
    cb('supabase/migrations/059_domain_isolation_hardening.sql:23\n  "dal.actor_id" skal være "dal.actor_user_id"\n  (Schema 058:154 definerer kolonnen som actor_user_id.)\n  Impact: super-admin kan ikke query domain_suspicious_access.', 'text'),

    h(3, 'Bug 2 — match_domain_embeddings RPC fejler runtime'),
    cb('supabase/migrations/059_domain_isolation_hardening.sql:143\n  "de.content" skal være "de.chunk_text"\n  (Schema 058:138 definerer kolonnen som chunk_text.)\n  Impact: vector search fejler, hele AI-pipeline brudt.', 'text'),

    h(3, 'Gap 1 — Ingen ESLint-rule'),
    p(txt('Ingen regel der forbyder '), code("supabase.from('domain_*')"), txt(' udenfor helpers. Kun kommentar-advarsler. Nye udviklere vil lovligt kunne bypasse '), code('domainScopedQuery()'), txt('.')),
    cb(
`// Tilføj til eslint.config.mjs rules-sektionen:
'no-restricted-syntax': ['error', {
  selector: "CallExpression[callee.object.name='supabase'][callee.property.name='from'][arguments.0.value=/^domain_/]",
  message: 'Brug domainScopedQuery() eller caseScopedQuery() — rå cross-domain-queries er forbudt (BIZZ-722).'
}]`,
      'javascript'
    ),

    h(3, 'Gap 2 — Ingen anomaly-detection cron'),
    p(txt('Ticket beskrev daglig cron-job der querier '), code('domain_suspicious_access'), txt(' og sender alert ved hits. Ingen '), code('/api/cron/domain-anomalies/route.ts'), txt(' fundet.')),

    h(3, 'Gap 3 — Ingen isolation-testsuite'),
    p(txt('Ticket acceptance listede 11 specifikke tests. '), code('__tests__/domain/isolation.test.ts'), txt(' eksisterer ikke. For isolation-kritisk kode er dette en FAIL, ikke en nit.')),

    h(2, 'Hvad der skal gøres før ticket kan Done\'es'),
    ul(
      li(p(txt('Ny migration '), code('060_fix_domain_schema_column_refs.sql'), txt(' der retter '), code('actor_id → actor_user_id'), txt(' i view + '), code('content → chunk_text'), txt(' i RPC.'))),
      li(p(txt('ESLint-rule aktiveret i '), code('eslint.config.mjs'), txt(' (snippet ovenfor).'))),
      li(p(txt('Cron-route '), code('app/api/cron/domain-anomalies/route.ts'), txt(' med CRON_SECRET-gate + Resend-email ved hits.'))),
      li(p(txt('Testsuite '), code('__tests__/domain/isolation.test.ts'), txt(' med alle 11 scenarier fra ticket-spec — minimum cross-domain READ og cross-domain WRITE skal verificeres.'))),
    ),

    p(strong('Note: '), txt('Bugs 1+2 er også blockere for BIZZ-698 (samme migration).'))
  ]
};

const r = await req('POST', '/rest/api/3/issue/BIZZ-722/comment', { body });
console.log(r.status === 201 ? '✅ BIZZ-722 comment posted' : `❌ ${r.status} ${r.body.slice(0, 400)}`);
