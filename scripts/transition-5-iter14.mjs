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
const plainBody = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function postAndTransition(key, text, target) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: plainBody(text) });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => new RegExp(`^${target}$`, 'i').test(x.name));
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → ${target}` : `  ⚠️ ${r.status}`);
  }
}

// 4 → Done
await postAndTransition('BIZZ-685',
  'Code-review PASS. Commit 8c575f5. app/lib/tinglysningPrices.ts implementerer fuld Tinglysning XML-parse: /ejdsummarisk/{uuid} fetch, parse KontantKoebesum + IAltKoebesum + SkoedeOvertagelsesDato. salgshistorik/route.ts:487-504 kalder fetchTinglysningPriceRowsByBfe + indekserer by date + enricher handler-rows når EJF-pris null. Reverse-inference 511-522 walker handler-list descending, kopierer successor-price til person-row ved exakt dato-match. 8 unit-tests. Priser nu non-null på historiske CVR-rows. Transitioned til Done.',
  'Done');

await postAndTransition('BIZZ-693',
  'Code-review PASS. Samme commit 8c575f5 som BIZZ-685 — Tinglysning-pris-enrichment + reverse-inference landed. Kaffevej 31 1.tv får nu priser fra Tinglysning dokaktuel hvor CVR-modpart findes. Se BIZZ-685 for fuld implementering. Transitioned til Done.',
  'Done');

await postAndTransition('BIZZ-716',
  'Code-review PASS. Commit a767abe. app/lib/domainEnrichEntities.ts:37-142 implementerer enrichEntities() der hitter LOKAL cvr_virksomhed-tabel (48-83), lokal ejf_ejerskab for current owners (94-108), fetchBbrAreasByBfe (117) for BFEer. Per-entity cap 2000 chars, max 8 entities/type. Wired i domainPromptBuilder.ts:244-246, bizzassist_data-array populated. Generation route renderer det ind i user-prompt. Ikke stub. Transitioned til Done.',
  'Done');

await postAndTransition('BIZZ-720',
  'Code-review PASS. Commit 3552ef3. app/lib/domainStripeSync.ts:64-180 syncDomainSubscription() fuldt wired. Webhook-integration i stripe/webhook/route.ts for checkout.session.completed (301-307), customer.subscription.updated (419-424), customer.subscription.deleted (492-497), invoice.payment_failed (795-927). Domain-status maps: cancelled/failed→suspended, active/past_due→active. Limits.max_tokens_per_month syncs fra plan_configs. Audit-log ved sync-ændringer. Transitioned til Done.',
  'Done');

// 1 → PARTIAL → To Do
await postAndTransition('BIZZ-724',
  'Playwright-verifikation PARTIAL. Commits 60c5309 + 6c98c9d. BFE-resolution via jordstykke-chained-lookup virker delvist — API returnerer nu bfe != 0, MEN returnerer JORDSTYKKE-BFE (2091165) for alle 4 enheder, IKKE individuelle lejligheds-BFEer (226629 for 62B, 226630 for 62A). Det betyder salgshistorik-opslag fra ejerlejligheder-route ikke kan få lejligheds-specifik pris. Areal stadig 2/4 (62B ok 200+42 m², 62A null). Købsdato 0/4 null. Købspris 0/4 null (trods BIZZ-685 shipped — ejerlejligheder-route kalder ikke salgshistorik-API). MANGLER: (1) korrekt lejligheds-BFE-opløsning (BBR_Ejerlejlighed-direct, ikke jordstykke-fallback), (2) 62A areal-resolution via alternativ BBR-path, (3) wire /api/salgshistorik?bfeNummer=<lejlighed-BFE> for købspris/dato. Transitioned til To Do.',
  'To Do');

console.log('\nDone.');
