#!/usr/bin/env node
/**
 * Opret 4 retroactive JIRA-tickets for fixes der allerede er shipped.
 * De oprindelige commit-messages refererede til "BIZZ-651/652/653/654"
 * som placeholder — de numre blev dog tildelt CVR-bulk-ingestion (BIZZ-651/652)
 * i stedet. Denne scripts opretter tickets for de faktiske leverancer og
 * marker dem Done med kommentar pegende på implementerings-commit.
 */
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

const tickets = [
  {
    summary:
      'AI endpoints: scrub env-var-name leak + unified buy-tokens CTA banner (c4f409c)',
    labels: ['ai', 'billing', 'iso27001', 'ux'],
    description: [
      h(2, 'Leveret via commit c4f409c (på main)'),
      p(
        txt(
          '10 AI-endpoints lækkede "BIZZASSIST_CLAUDE_KEY ikke konfigureret" direkte til UI når nøglen manglede — både ISO 27001-brud og dårlig UX uden actionable CTA. Fixet: generisk besked "AI er midlertidigt utilgængelig..." + '
        ),
        code('code: ai_unavailable'),
        txt(' så klienten kan route gennem samme buy-tokens-banner som 402 trial_ai_blocked. AIChatPanel viser banneret for begge koder.')
      ),
      p(strong('Status: '), txt('Done. Deployed til test.bizzassist.dk og main.')),
      p(strong('Note: '), txt('Oprindelig commit-msg refererede til "BIZZ-651" som placeholder. Det number blev efterfølgende tildelt CVR bulk-ingestion — denne ticket erstatter reference.')),
    ],
  },
  {
    summary: 'Support-chat: ungate /api/support/chat — rely on abuse lockout only (1c59459)',
    labels: ['support-chat', 'ai', 'pre-purchase-ux'],
    description: [
      h(2, 'Leveret via commit 1c59459 (på main)'),
      p(
        txt(
          'Ikke-betalende brugere kunne ikke stille pre-purchase spørgsmål til support fordi BIZZ-649 gate-fix blokerede dem. Fjern gate fra '
        ),
        code('/api/support/chat'),
        txt(' og stol på eksisterende 3-lags abuse-værn: aiRateLimit (10/min/IP) + '),
        code('public.support_chat_abuse'),
        txt(' (50k tokens/time eskalerende lockout) + ABUSE_TOKEN_THRESHOLD-check.')
      ),
      p(strong('Status: '), txt('Done. Dokumenteret i auto-memory så fremtidige sweeps ikke wirer support/chat tilbage.')),
      p(strong('Note: '), txt('Placeholder-ref "BIZZ-652" blev tildelt CVR runtime swap. Denne ticket erstatter reference.')),
    ],
  },
  {
    summary:
      'AI gate: block active subscriptions with isPaid=false (crossshoppen case) (048ee7a)',
    labels: ['ai', 'billing', 'gate', 'p0'],
    description: [
      h(2, 'Leveret via commit 048ee7a (på main)'),
      p(
        txt(
          'requires_approval-plan oprettes som status=active + isPaid=false indtil Stripe/admin bekræfter. BIZZ-649 gate checkede kun status, så disse "active men ubetalte" brugere kunne forbruge fulde plan-tokens. Block på gate-niveau med same trial_ai_blocked code (buy-tokens banner). Backwards-compat: gamle subs uden isPaid-felt tillades fortsat. +3 unit-tests (13 total).'
        )
      ),
      p(strong('Status: '), txt('Done. Verificeret live: crossshoppen@gmail.com blokeres nu korrekt.')),
      p(strong('Note: '), txt('Placeholder-ref "BIZZ-653" i commit body er forældet.')),
    ],
  },
  {
    summary: 'Navigation: expose /dashboard/tokens in sidebar for regular users (9d0e627)',
    labels: ['navigation', 'ux', 'tokens'],
    description: [
      h(2, 'Leveret via commit 9d0e627 (på main)'),
      p(
        txt(
          'UI til token-pack-køb fandtes allerede på '
        ),
        code('/dashboard/tokens'),
        txt(
          ' (Stripe topup-checkout), men regulære brugere havde ingen synlig vej dertil — den eneste indgang var trial-blocked-banneret inde i AI-chatten. Tilføjet "Tokens"-entry (Coins-ikon) i sidebar, DA/EN translations.'
        )
      ),
      p(strong('Status: '), txt('Done.')),
      p(strong('Note: '), txt('Placeholder-ref "BIZZ-654" i commit body er forældet.')),
    ],
  },
];

async function createAndMarkDone(t) {
  const body = {
    fields: {
      project: { key: 'BIZZ' },
      issuetype: { name: 'Task' },
      priority: { name: 'Medium' },
      summary: t.summary,
      labels: t.labels,
      description: { type: 'doc', version: 1, content: t.description },
    },
  };
  const r = await req('POST', '/rest/api/3/issue', body);
  if (r.status !== 201) {
    console.error('FAIL', r.status, r.body.slice(0, 300));
    return null;
  }
  const key = JSON.parse(r.body).key;
  console.log('✅', key, '-', t.summary.slice(0, 70));
  // Transition to Done
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const done = (JSON.parse(tr.body).transitions || []).find((x) => /^done$/i.test(x.name));
  if (done) {
    const rr = await req('POST', `/rest/api/3/issue/${key}/transitions`, {
      transition: { id: done.id },
    });
    console.log(rr.status === 204 ? `   → Done` : `   → ⚠️ ${rr.status}`);
  }
  return key;
}

const keys = [];
for (const t of tickets) {
  keys.push(await createAndMarkDone(t));
}

console.log('\nCreated + Done:');
console.log(`  ${keys[0]} — env-var scrub + unified CTA (was "BIZZ-651" in commit c4f409c)`);
console.log(`  ${keys[1]} — ungate support-chat (was "BIZZ-652" in commit 1c59459)`);
console.log(`  ${keys[2]} — active + isPaid=false (was "BIZZ-653" in commit 048ee7a)`);
console.log(`  ${keys[3]} — tokens in sidebar (was "BIZZ-654" in commit 9d0e627)`);
