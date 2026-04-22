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
  fields: {
    project: { key: 'BIZZ' },
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    summary: 'Runbook: Stripe webhook-delivery fejlsøgning for betalende kunder',
    labels: ['runbook', 'ops', 'stripe', 'documentation', 'billing'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Kontekst'),
        p(
          txt(
            'BIZZ-544 (Stripe webhook prod-launch) er Done, men acceptance listede "Runbook opdateret" som delvis åben. Denne ticket dækker den sidste del: en konkret fejlsøgnings-vejledning for ops når en kunde rapporterer at deres betaling ikke blev registreret korrekt.'
          )
        ),
        h(2, 'Mål'),
        p(
          txt(
            'Vejledning placeret i '
          ),
          code('docs/runbooks/stripe-webhook.md'),
          txt(' (eller tilsvarende runbook-folder) som en oncall-engineer kan følge uden at kende webhook-arkitekturen på forhånd.')
        ),
        h(2, 'Skal dække'),
        ul(
          li(
            p(
              strong('Symptomcheck: '),
              txt(
                'hvordan verificerer man at en given kundes checkout faktisk blev registreret? (Stripe dashboard invoice-status + Supabase subscription-state + Resend email-log).'
              )
            )
          ),
          li(
            p(
              strong('Stripe event-lookup: '),
              txt('sådan finder man '),
              code('pending_webhooks'),
              txt('-count og delivery-attempts per event i Stripe Dashboard → Developers → Events.')
            )
          ),
          li(
            p(
              strong('Webhook-endpoint status: '),
              txt('de 2 enabled endpoints ('),
              code('bizzassist.dk'),
              txt(' + '),
              code('test.bizzassist.dk'),
              txt(') — hvilket miljø forventes at rammes for en given event-type, hvilke enabled_events.')
            )
          ),
          li(
            p(
              strong('Supabase fallback-resolution: '),
              txt('den 3-step user-resolution '),
              code('stripe webhook'),
              txt(' bruger (metadata → stripe_customer_id → email) dokumenteret med eksempler.')
            )
          ),
          li(
            p(
              strong('Replay: '),
              txt(
                'sådan replays en specifik event fra Stripe dashboard hvis webhook-processoren fejlede.'
              )
            )
          ),
          li(
            p(
              strong('Sentry signaler: '),
              txt('hvilke Sentry tags/breadcrumbs man skal søge efter ('),
              code('webhook_event=invoice.payment_succeeded'),
              txt(', '),
              code('step=planTokensUsed_reset'),
              txt(' osv.).')
            )
          ),
          li(
            p(
              strong('Grace-period + never-return-500 invariant: '),
              txt(
                'kort forklaring af policy så nye oncall-engineers forstår hvorfor webhooken aldrig returnerer 5xx.'
              )
            )
          )
        ),
        h(2, 'Referencer'),
        ul(
          li(
            p(
              code('app/api/stripe/webhook/route.ts'),
              txt(' — hovedhandler (kodeforklaring i JSDoc).')
            )
          ),
          li(
            p(
              code('/root/.claude/projects/-root-BizzAssist/memory/reference_stripe_webhook.md'),
              txt(' — intern memory-note (privat, '),
              strong('må ikke'),
              txt(' copy-pastes ind i docs-filen).')
            )
          ),
          li(p(code('docs/runbooks/'), txt(' — placér den nye fil her.')))
        ),
        h(2, 'Acceptance criteria'),
        ul(
          li(p(txt('Fil '), code('docs/runbooks/stripe-webhook.md'), txt(' oprettet + committed.'))),
          li(p(txt('Oncall-engineer kan følge trinnene uden ekstern hjælp.'))),
          li(p(txt('Linket fra '), code('CLAUDE.md'), txt(' eller anden central oversigts-fil.'))),
          li(
            p(
              txt('Ingen secrets, webhook signing keys eller customer-PII er inkluderet i dokumentet.')
            )
          )
        ),
        h(2, 'Relateret'),
        p(
          code('BIZZ-544'),
          txt(
            ' (Done) — pre-launch webhook-switch. Denne ticket lukker den sidste acceptance-bullet derfra.'
          )
        ),
      ],
    },
  },
};

const r = await req('POST', '/rest/api/3/issue', body);
if (r.status !== 201) {
  console.error('FAIL', r.status, r.body.slice(0, 400));
  process.exit(1);
}
const key = JSON.parse(r.body).key;
console.log('✅', key, '— runbook-ticket oprettet (To Do, Medium)');
// Link til BIZZ-544 som "relates"
const lr = await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key },
  outwardIssue: { key: 'BIZZ-544' },
});
console.log(lr.status === 201 ? `🔗 relates to BIZZ-544` : `link-warn: ${lr.status}`);
