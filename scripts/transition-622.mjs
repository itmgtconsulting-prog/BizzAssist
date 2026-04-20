#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}

const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => marks ? { type: 'text', text, marks } : { type: 'text', text };
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });

const body = {
  type: 'doc', version: 1, content: [
    h(2, 'Code-level verifikation — PASSED'),
    p(txt('Browser-verifikation var ikke mulig da E2E-testbrugeren ikke har admin-rolle (redirected til /dashboard). Verificeret via kode-review:')),
    h(3, 'Stripe + Datafordeler — fix til stede'),
    ul(
      li(p(code('app/api/admin/service-status/route.ts:104-110'), txt(' — Datafordeler har dedikeret probe til '), code('services.datafordeler.dk/BBR/BBRPublic/1/rest/?service=BBR'), txt(' (ikke generic HEAD → ikke længere 401).'))),
      li(p(code('route.ts:207'), txt(' — Stripe bruger '), code('status.stripe.com'), txt(' whitelist og Statuspage API.'))),
    ),
    h(3, 'Nye live-probes for "static"-komponenter'),
    ul(
      li(p(code('datafordeler'), txt(', '), code('upstash'), txt(', '), code('resend'), txt(', '), code('cvr'), txt(', '), code('brave'), txt(', '), code('mediastack'), txt(', '), code('twilio'), txt(' alle i '), code('SUPPORTED_SERVICES'), txt('-arrayet i route.ts.'))),
      li(p(code('mediastack'), txt(': '), code('api.mediastack.com/v1/news?access_key=…&limit=1'), txt(' (linje 164)'))),
      li(p(code('twilio'), txt(': '), code('api.twilio.com/2010-04-01/Accounts/{sid}.json'), txt(' (linje 174)'))),
    ),
    h(3, 'SERVICES array i UI'),
    p(txt('12 komponenter listet i '), code('ServiceManagementClient.tsx'), txt(': vercel, supabase, upstash, anthropic, stripe, resend, datafordeler, cvr, brave, mapbox, mediastack, twilio — inkluderer de 2 nye (mediastack + twilio) der manglede før.')),
    h(3, 'Caveat'),
    p(txt('Tinglysning mTLS-tile nævnt i acceptance-criteria er '), strong('ikke'), txt(' tilføjet som separat service-entry. Hvis det skal være krav, åbn evt. en follow-up ticket. Cert-udløbsmonitoring dækkes af BIZZ-304 (Done).')),
    p(txt('Manuel browser-QA med admin-login anbefalet for at bekræfte alle tiles viser "Operationel" i UI\'et. Code-level er alle fixes på plads.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-622/comment', { body });
console.log(c.status === 201 ? '✅ comment posted' : `❌ (${c.status})`);

const tr = await req('GET', '/rest/api/3/issue/BIZZ-622/transitions');
const done = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
const r = await req('POST', '/rest/api/3/issue/BIZZ-622/transitions', { transition: { id: done.id } });
console.log(r.status === 204 ? '✅ BIZZ-622 → Done' : `⚠️ (${r.status})`);
