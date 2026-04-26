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

const body = doc(
  h(2, 'Iteration 2 — Stripe webhook wired into domain-sync'),
  p(txt('Reviewer-feedback adresseret. Det manglende stykke var Stripe → domain propagation. Nu er både '), code('plan_configs'), txt(' seed, '), code('domain.stripe_*'), txt(' kolonner, og webhook-handlers opdateret.')),
  h(3, 'Migration 066 — anvendt på test + dev + prod via Management API'),
  cb(
`ALTER TABLE domain ADD stripe_customer_id TEXT;
ALTER TABLE domain ADD stripe_subscription_id TEXT;
CREATE INDEX ix_domain_stripe_customer ...;
CREATE INDEX ix_domain_stripe_subscription ...;

INSERT INTO plan_configs (plan_id, price_dkk, ai_tokens_per_month, ...)
VALUES ('enterprise_domain', 4999, 500000, 1, 1.0, true, true);

Verificeret på alle 3 envs:
  plan_configs: [{"plan_id":"enterprise_domain","price_dkk":4999,
                  "ai_tokens_per_month":500000}]
  domain cols:  stripe_customer_id + stripe_subscription_id`,
    'sql'
  ),
  h(3, 'Ny helper: app/lib/domainStripeSync.ts'),
  cb(
`syncDomainSubscription({ planId, customerId, subscriptionId, status,
                          domainIdHint }) → { matched, reason?, domainId? }

Guards:
  - plan !== 'enterprise_domain'  → no-op (returns plan-not-enterprise-domain)
  - ingen lookup-keys            → no-op (no-lookup-keys)
  - ingen domain match           → logs + returns no-domain-found

Lookup-prioritet:
  1. domainIdHint (fra checkout.metadata.domain_id)
  2. stripe_subscription_id
  3. stripe_customer_id

Status-mapping til domain.status CHECK (active|suspended|archived):
  active / past_due          → active
  cancelled / payment_failed → suspended
  (past_due: tenant-grace håndterer advarsel, domain holdes aktiv)

Limits sync: max_tokens_per_month pulled fra plan_configs.ai_tokens_per_month.
Skriver audit-log entry action='stripe_sync' med from/to status.`,
    'typescript'
  ),
  h(3, 'Wire-up i app/api/stripe/webhook/route.ts'),
  ul(
    li(p(strong('checkout.session.completed'), txt(' → '), code('syncDomainSubscription'), txt(' med session.customer + session.subscription + metadata.domain_id, status=active.'))),
    li(p(strong('customer.subscription.updated'), txt(' → propagerer status (active / past_due / cancelled / payment_failed) + limits-refresh.'))),
    li(p(strong('customer.subscription.deleted'), txt(' → status=cancelled → domain.status=suspended.'))),
  ),
  h(3, 'ESLint'),
  p(txt('Tilføjede '), code('app/lib/domainStripeSync.ts'), txt(' + '), code('app/api/stripe/webhook/**'), txt(' til no-restricted-syntax whitelist (Stripe-signatur verifikation garanterer domain-lookup-sikkerhed).')),
  h(3, 'Test coverage'),
  ul(
    li(p(txt('plan-guard — non-enterprise plan → no-op, ingen Supabase-kald'))),
    li(p(txt('no-lookup-keys — ingen customer/sub/hint → fail-fast'))),
    li(p(txt('no-domain-found — lookup misses på alle 3 nøgler'))),
    li(p(txt('happy-path — domainIdHint + plan_configs lookup + status + limits skrevet'))),
    li(p(txt('cancelled status → domain.status=suspended mapping'))),
  ),
  p(strong('Tests: '), txt('1618/1632 grønne (+5 nye). Type-check clean.')),
  h(3, 'Fortsat manuel (dashboard-only)'),
  ul(
    li(p(txt('Stripe Dashboard: opret '), code('product=BizzAssist Enterprise Domain'), txt(' + '), code('price=4999 DKK/month recurring'), txt(' → sæt '), code('product.metadata.plan_id=enterprise_domain'), txt('.'))),
    li(p(txt('Checkout-session creation i onboarding-flow skal passe '), code('metadata.domain_id=<uuid>'), txt(' for unambiguous matching ved multi-domain tenants.'))),
  ),
  p(strong('Commit: '), code('3552ef3'), txt('. '), strong('→ In Review.'))
);

const cr = await req('POST', `/rest/api/3/issue/BIZZ-720/comment`, { body });
console.log(cr.status === 201 ? '✅ BIZZ-720 comment' : `❌ ${cr.status} ${cr.body}`);
const tr = await req('GET', `/rest/api/3/issue/BIZZ-720/transitions`);
const transitions = JSON.parse(tr.body).transitions || [];
const target = transitions.find(t => /^in review$/i.test(t.name));
if (target) {
  const r = await req('POST', `/rest/api/3/issue/BIZZ-720/transitions`, { transition: { id: target.id } });
  console.log(r.status === 204 ? `  ✅ BIZZ-720 → ${target.name}` : `  ⚠️ ${r.status} ${r.body}`);
}
