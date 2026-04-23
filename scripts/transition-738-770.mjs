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
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const perTicket = {
  'BIZZ-770': { type: 'doc', version: 1, content: [
    p(strong('Phase 1 shipped — External/Internal split + 7 new internal cards')),
    p(txt('ServiceManagementClient rendrer nu 2 sections:')),
    ul(
      li(p(strong('Eksterne interfaces:'), txt(' 14 eksisterende 3rd-party services (Vercel/Supabase/Anthropic/Stripe/Resend/Datafordeler/CVR/Brave/Mapbox/Twilio/Mediastack/Upstash/...)'))),
      li(p(strong('Interne komponenter:'), txt(' 7 nye cards (Database/Rate Limiter/pgvector/Cron Jobs/Audit Log/Email Queue/AI Token Burn). Alle static "Unknown" indtil iter 2 wirer live metrics.'))),
    ),
    p(strong('Iter 2 scope (parkeret):')),
    ul(
      li(p(code('BIZZ-770a'), txt(' — Database query latens p50/p95/p99, connection pool metrics'))),
      li(p(code('BIZZ-770b'), txt(' — Upstash rate-limiter blocked-counts, eviction rate'))),
      li(p(code('BIZZ-770c'), txt(' — pgvector queue depth, last re-index timestamp'))),
      li(p(code('BIZZ-770d'), txt(' — Sentry SDK full integration (tags, source maps, breadcrumbs)'))),
      li(p(code('BIZZ-770e'), txt(' — Alert configuration UI + notification channels (Sentry/email/SMS)'))),
    ),
    p(strong('Commit: '), code('459c138'), txt('. Tests 1640/1654 grønne. '), strong('→ In Review (phase 1 shipped).')),
  ]},
  'BIZZ-738': { type: 'doc', version: 1, content: [
    p(strong('Gate 2 + 4 shipped — manuelle gates (1, 3, 5) venter stadig')),
    p(strong('Gate 2 — Onboarding metadata.domain_id:')),
    ul(
      li(p(code('/api/stripe/create-checkout'), txt(' POST body accepterer nu optional '), code('domainId'), txt(' (UUID). Når set skrives det til '), code('session.metadata'), txt(' + '), code('subscription.metadata'), txt('.'))),
      li(p(code('syncDomainSubscription'), txt(' (fra BIZZ-720) læser allerede '), code('metadata.domain_id'), txt(' som preferred lookup key. Unblocks multi-domain onboarding flow hvor stripe_customer_id ikke er unique.'))),
    ),
    p(strong('Gate 4 — Pentest smoke-suite:')),
    ul(
      li(p(code('__tests__/domain/pentest.integration.test.ts'), txt(' — 14 tests dækker 8/10 scenarier fra DOMAIN_SECURITY.md:'))),
      li(p(txt('1. URL Manipulation, 3. Storage Path Guessing, 4. SQL Injection, 5. Prompt Injection, 8. Lateral Movement via AI, 9. Token-cap guard — '), strong('direct-code assertions'))),
      li(p(txt('2. JWT Replay, 6. DOCX Zip-bomb, 7. PDF CVE, 10. Cascade Delete — '), strong('meta-tests'), txt(' der peger på hvor de er dækket (isolation.integration.test.ts, upload size caps, pdf-parse dynamic import, FK ON DELETE CASCADE).'))),
    ),
    p(txt('Dette erstatter '), strong('ikke'), txt(' den eksterne pentest som kræves for GA signoff — det er en regression-guard så fremtidige PRs ikke silent-breakker isolation/injection-guards.')),
    p(strong('Fortsat manuelt (ikke kode):')),
    ul(
      li(p(strong('Gate 1:'), txt(' Stripe Dashboard — opret enterprise_domain product + price, sæt product.metadata.plan_id=enterprise_domain'))),
      li(p(strong('Gate 3:'), txt(' ISO 27001 signoff fra CODE REVIEWER + ARCHITECT på DOMAIN_SECURITY.md'))),
      li(p(strong('Gate 5:'), txt(' Ekstern pentest gennemført + DOMAIN_FEATURE_ENABLED=true i production Vercel env'))),
    ),
    p(strong('Commit: '), code('459c138'), txt('. Tests 1640/1654 grønne (+14 pentest). '), strong('→ In Review (gate 2+4 shipped, gate 1+3+5 er non-code).')),
  ]},
};

for (const [key, body] of Object.entries(perTicket)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const target = (JSON.parse(tr.body).transitions || []).find((t) => /^in review$/i.test(t.name));
  if (target) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → In Review` : `  ⚠️ ${r.status}`);
  }
}
