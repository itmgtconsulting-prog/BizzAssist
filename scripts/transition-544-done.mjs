#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString(
  'base64'
);
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method: m,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
        },
      },
      (x) => {
        let y = '';
        x.on('data', (c) => (y += c));
        x.on('end', () => res({ status: x.statusCode, body: y }));
      }
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

const body = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'E2E-verifikation — PASS (prod)'),
    p(
      strong('Live checkout gennemført: '),
      code('jjrchefen@gmail.com'),
      txt(' købte Bizzassist Beta (150 kr/md) på '),
      code('https://bizzassist.dk'),
      txt(' i dag kl. 14:55 CEST. Alle led i kæden er verificeret.')
    ),
    h(3, 'Stripe'),
    ul(
      li(
        p(
          strong('Prod-endpoint: '),
          code('we_1TOcvMFjiBVUHqsWUYEyg3aS'),
          txt(' → '),
          code('https://bizzassist.dk/api/stripe/webhook'),
          txt(' · enabled · 9 events')
        )
      ),
      li(
        p(
          strong('Test-endpoint bevaret: '),
          code('we_1TIdJ7FjiBVUHqsWH0AKJkyo'),
          txt(' → '),
          code('https://test.bizzassist.dk/api/stripe/webhook'),
          txt(' · enabled · 9 events')
        )
      ),
      li(
        p(
          strong('Event-delivery: '),
          txt('alle 8 relevante events for sessionen ('),
          code('checkout.session.completed'),
          txt(', '),
          code('customer.subscription.created'),
          txt(', '),
          code('invoice.{created,finalized,paid,payment_succeeded}'),
          txt(', '),
          code('invoice_payment.paid'),
          txt(') rapporterer '),
          code('pending_webhooks: 0'),
          txt(' → leveret succesfuldt.')
        )
      )
    ),
    h(3, 'PROD Supabase subscription-state'),
    p(
      code(
        'SELECT raw_app_meta_data->subscription FROM auth.users WHERE email=\'jjrchefen@gmail.com\''
      )
    ),
    ul(
      li(p(code('planId: "bizzassist-beta"'))),
      li(p(code('status: "active"'))),
      li(p(code('isPaid: true'))),
      li(p(code('approvedAt: "2026-04-21T12:55:42.618Z"'))),
      li(p(code('periodStart: "2026-04-21T12:55:42.618Z"'))),
      li(p(code('tokensUsedThisMonth: 0')))
    ),
    p(
      txt('Matcher UI-visning: "Godkendt 21. april 2026", "Status Aktiv", "AI-forbrug 0 / 500.000".')
    ),
    h(3, 'Emails (Resend delivered)'),
    ul(
      li(p(code('12:53'), txt(' "Bekræft din email — BizzAssist" → delivered'))),
      li(p(code('12:54'), txt(' "Din adgang til BizzAssist er godkendt" → delivered'))),
      li(p(code('12:55'), txt(' "Betaling gennemført — BizzAssist" → delivered')))
    ),
    h(3, 'Acceptance gennemgang'),
    ul(
      li(p(txt('✓ Produktions-webhook oprettet i Stripe LIVE for '), code('www.bizzassist.dk')))
      ,
      li(p(txt('✓ Signing secret gemt som Vercel env-var (production only)'))),
      li(p(txt('✓ Alle 9 events enabled på prod-endpointet'))),
      li(p(txt('✓ E2E checkout + webhook + Supabase subscription update verificeret end-to-end'))),
      li(
        p(
          strong('Runbook: '),
          txt(
            'pending — anbefaling: separat doc-ticket. Quick-ref: for webhook-debugging, tjek Stripe Dashboard → Developers → Events → '
          ),
          code('pending_webhooks'),
          txt(' count + Resend logs for mail-delivery.')
        )
      )
    ),
    p(strong('BIZZ-544 → Done.'), txt(' Production-launch af betalende planer er unblocked.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-544/comment', { body });
console.log(c.status === 201 ? '✅ comment' : `❌ ${c.status} ${c.body}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-544/transitions');
const done = (JSON.parse(tr.body).transitions || []).find((t) => /^done$/i.test(t.name));
if (done) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-544/transitions', {
    transition: { id: done.id },
  });
  console.log(r.status === 204 ? '✅ BIZZ-544 → Done' : `⚠️ ${r.status} ${r.body}`);
}
