#!/usr/bin/env node
/**
 * Rydder op i In Review køen:
 * - 5 Domain specs (697-701): tilføj klar statustekst + transition til To Do
 * - BIZZ-685/693 + 694/695: håndteres separat (685/693 re-transitioneres, 694/695 verificeres via Playwright)
 */
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
const doc = (...blocks) => ({ type: 'doc', version: 1, content: blocks });

// Domain specs — behøver transitioneres til To Do fordi de lige er oprettet
const domainSpecs = [
  { key: 'BIZZ-697', what: 'ADR + design-signoff (docs/adr/ADR-XXX-domain-feature.md)', blocks: 'ALLE øvrige domain-tickets (BIZZ-698 til BIZZ-722)' },
  { key: 'BIZZ-698', what: 'Supabase migration med 9 domain-tabeller + RLS + SECURITY DEFINER helpers', blocks: 'BIZZ-700 og downstream (schemaen skal være deployed før auth-helpers/API-rutter kan kodes)' },
  { key: 'BIZZ-699', what: 'app/lib/featureFlags.ts + middleware-gate + Vercel env-vars i 3 targets', blocks: 'BIZZ-701+ (UI-tickets skal gate på flaget)' },
  { key: 'BIZZ-700', what: 'app/lib/domainAuth.ts + domainStorage.ts + Supabase Storage RLS policies', blocks: 'BIZZ-701 (Fase 1 → 2 start)' },
  { key: 'BIZZ-701', what: 'Super-admin UI på /dashboard/admin/domains: list/create/suspend + API-routes', blocks: 'BIZZ-702' },
];

for (const { key, what, blocks } of domainSpecs) {
  const body = doc(
    h(2, 'Status clarification'),
    p(strong('Denne ticket er en '), strong('specifikation — ikke implementeret endnu'), txt('.')),
    p(strong('Forventet leverance: '), txt(what)),
    p(strong('Blokerer: '), txt(blocks)),
    p(strong('Parent: '), code('BIZZ-696'), txt(' (Domain Management Epic).')),
    h(3, 'Hvad verifikation vil kræve (når implementering er klar)'),
    p(txt('Se Acceptance-sektionen i description + udvidet implementerings-kommentar ovenfor. Kode-reference til hvor leverancen skal ligge står i hver sektion.')),
    h(3, 'Næste trin'),
    p(txt('Transitionerer tilbage til '), strong('To Do'), txt('. Afventer developer-claim før implementering starter.'))
  );
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} status-comment posted` : `❌ ${key} comment ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const trans = JSON.parse(tr.body).transitions || [];
  const toDo = trans.find(t => /^to do$/i.test(t.name)) || trans.find(t => /^open$/i.test(t.name));
  if (toDo) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: toDo.id } });
    console.log(r.status === 204 ? `   ✅ ${key} → ${toDo.name}` : `   ⚠️ transition ${r.status}`);
  } else {
    console.log(`   ⚠️ ${key} no "To Do" transition; available: ${trans.map(t => t.name).join(', ')}`);
  }
}

// BIZZ-685 + BIZZ-693 — re-transition med kort note om at de afventer implementation
for (const key of ['BIZZ-685', 'BIZZ-693']) {
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const trans = JSON.parse(tr.body).transitions || [];
  const toDo = trans.find(t => /^to do$/i.test(t.name));
  if (toDo) {
    const note = doc(
      h(2, 'Status clarification'),
      p(strong('Denne ticket afventer implementation'), txt(' — fix-plan er fastlagt i den opdaterede kommentar ovenfor (lokal '), code('public.ejf_ejerskab'), txt(' + Tinglysning '), code('/soegvirksomhed/cvr'), txt(' + '), code('/dokaktuel/uuid/{uuid}'), txt(' enrichment + reverse-inference).')),
      p(strong('Ingen kode er skrevet endnu. Ikke verifikationsklar. Transitioner til To Do.'))
    );
    await req('POST', `/rest/api/3/issue/${key}/comment`, { body: note });
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: toDo.id } });
    console.log(r.status === 204 ? `✅ ${key} → To Do` : `⚠️ ${key} transition ${r.status}`);
  }
}

console.log('\nDone. Now tickets BIZZ-694 and BIZZ-695 remain for Playwright verification.');
