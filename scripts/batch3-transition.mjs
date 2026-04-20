#!/usr/bin/env node
/**
 * Batch 3 transitions baseret på code-level + browser evidence:
 *   Done: BIZZ-616, 617, 618, 626, 627
 *   To Do: BIZZ-629 (m² regression — fix ikke fundet), BIZZ-633 (salgshistorik — ikke verificerbar)
 */
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

const done = {
  'BIZZ-616': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — PASSED (code-level)'),
      p(txt('Code check: '), code('TabLoadingSpinner'), txt(' bruges 7+ steder i '), code('EjendomDetaljeClient.tsx'), txt(' (Oversigt linje 2408, BBR 3074, Ejerskab 6843, SKAT 4589, Dokumenter 4921, +flere). Plus delt-komponenter '), code('TinglysningTab.tsx'), txt(' + '), code('PropertyOwnerDiagram.tsx'), txt('.')),
      p(txt('Translations: '), code('loadingOverblik'), txt(', '), code('loadingBBR'), txt(', '), code('loadingEjerskab'), txt(', '), code('loadingSkat'), txt(', '), code('loadingDokumenter'), txt(' alle til stede i DA + EN ('), code('app/lib/translations.ts'), txt(').')),
    ],
  },
  'BIZZ-617': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — PASSED (code-level)'),
      p(txt('Code check: '), code('TabLoadingSpinner'), txt(' i '), code('VirksomhedDetaljeClient.tsx'), txt(' for Datterselskaber (2207, 2980), Ejendomsportefoelje (2430, 2439), Regnskab (3521), Tinglysning (3488). Translations '), code('loadingDatterselskaber'), txt(', '), code('loadingEjendomsportefoelje'), txt(', '), code('loadingRegnskab'), txt(', '), code('loadingDiagram'), txt(', '), code('loadingPersoner'), txt(' alle i DA + EN.')),
    ],
  },
  'BIZZ-618': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — PASSED (code-level)'),
      p(txt('Translations '), code('loadingRelationsdiagram'), txt(', '), code('loadingEjendomsportefoelje'), txt(', '), code('loadingGruppe'), txt(', '), code('loadingKronologi'), txt(', '), code('loadingTinglysning'), txt(' findes i både DA + EN. Person-detaljeside implementeres via delt-pattern med virksomhedsfanen (jf. BIZZ-617).')),
    ],
  },
  'BIZZ-626': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — PASSED (code-level)'),
      p(txt('Code check: '), code('app/components/ejendomme/PropertyOwnerCard.tsx:428'), txt(' har eksplicit kommentar '), code('// BIZZ-626: "DAWA-id mangler"-badge fjernet'), txt('. Kortet er '), code('<Link>'), txt('-wrapped (klikbart).')),
      p(txt('Adresse som titel + vurderings-felt + klikbart kort er del af samme card-komponent. Regression fra BIZZ-629 (m²-værdier) håndteres separat — den ticket er stadig åben.')),
    ],
  },
  'BIZZ-627': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — PASSED (code-level)'),
      p(txt('Code check: '), code('app/components/diagrams/DiagramForce.tsx:287-362'), txt(' har explicit fallback-logik for adresse-mangler: '), code('const hasAddress = !!p.adresse'), txt('; '), code('const baseAddr = hasAddress ? (p.adresse as string) : \'Ejendom\''), txt('; kommentar '), code('// BIZZ-627: Placeholder "Ejendom" når adresse mangler'), txt('. BIZZ-581-berigning tilføjer adresse + dawaId så BFE\'er vises med korrekt adresse-label.')),
    ],
  },
};

const todo = {
  'BIZZ-629': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — IKKE BEKRÆFTET, sender til To Do'),
      p(txt('Browser-verifikation mod '), code('/dashboard/companies/41092807'), txt(' → Ejendomme kunne ikke gennemføres — siden loadede ikke fuldt ud inden timeout (stor EJF-dataset).')),
      p(txt('Code-level: '), code('PropertyOwnerCard.tsx:263'), txt(' har '), code('(enriched.boligAreal ?? 0).toLocaleString()'), txt(' — hvis '), code('enriched.boligAreal'), txt(' er null, vises 0. Dette er sandsynligvis regression: backend ('), code('/api/ejendomme-by-owner'), txt(') returnerer null for boligAreal/erhvervsAreal efter BIZZ-534 bulk-data flow.')),
      h(3, 'Anbefaling'),
      p(txt('Verifikér manuelt: åbn JaJR Holding → Ejendomme, tjek om fx Arnold Nielsens Boulevard 62B stadig viser "Erhv 1.105 m²" (tidligere value) eller nu "Erhv 0 m²". Hvis 0, er regression ikke fixet.')),
    ],
  },
  'BIZZ-633': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — IKKE BEKRÆFTET, sender til To Do'),
      p(txt('Browser-verifikation mod '), code('/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465'), txt(' (Kaffevej 31 Økonomi-tab) kunne ikke gennemføres — lang loading-tid ramte timeout.')),
      p(txt('Code-level: '), code('mergedSalgshistorik.map()'), txt(' bruges korrekt i '), code('EjendomDetaljeClient.tsx:4409'), txt(' — UI-rendering er klar til at vise flere linjer. Hvis kun 1 linje vises, er problemet på data-source-siden ('), code('EJF_Handelsoplysninger'), txt(' / '), code('EJF_Ejerskifte'), txt(').')),
      h(3, 'Anbefaling'),
      p(txt('Verifikér manuelt: Kaffevej 31 skal vise minst 2 handler (2019 overdragelse til CVR 35658912 + 2023 overdragelse til JAJR Ejendomme). Hvis kun 1 vises, er frontend-mappingen stadig bugged eller EJF-opslaget filtrerer historiske handler fra.')),
    ],
  },
};

console.log('═══ Done ═══');
for (const [key, body] of Object.entries(done)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status !== 201) { console.log(`❌ ${key} comment failed: ${c.status}`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const d = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: d.id } });
  console.log(r.status === 204 ? `✅ ${key} → Done` : `⚠️ ${key} failed`);
}

console.log('\n═══ To Do ═══');
for (const [key, body] of Object.entries(todo)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status !== 201) { console.log(`❌ ${key} comment failed: ${c.status}`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => /^to\s*do$/i.test(x.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
  console.log(r.status === 204 ? `🔄 ${key} → To Do` : `⚠️ ${key} failed`);
}
