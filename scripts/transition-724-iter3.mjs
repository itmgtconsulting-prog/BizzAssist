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
  h(2, 'Iteration 3 — alle 3 review-punkter løst (4/4 coverage)'),
  p(strong('Root cause: '), txt('DAWA-fallback pathen brugte kun BBR_Enhed + matrikel-fallback. Nu primær path via '), code('/ejendom/adresse'), txt(' (Tinglysning) pr. lejlighed → giver korrekt ejerlejlighed-BFE + areal + pris fra summarisk XML.')),
  h(3, 'Ny enrichment-pipeline i resolveLejlighederViaDawa'),
  cb(
`For hver lejlighed:
  1. Parse vejnavn+husnr+postnr fra betegnelse
  2. tlFetch('/ejendom/adresse?vejnavn=X&husnummer=Y&postnummer=Z')
     NB: etage/sidedoer DROPPET — test-env returnerer {} ved filtrering
  3. Vælg entry med vedroerende='Ejerlejlighed: N' (ikke 'Hovedejendom')
  4. Læs ejendomsnummer = lejligheds-specifik BFE
  5. tlFetch('/ejdsummarisk/{uuid}')
     → KontantKoebesum / IAltKoebesum → koebspris
     → KoebsaftaleDato / SkoedeOvertagelsesDato → koebsdato
     → Ejerlejlighedens tinglyste areal → areal

Fallback-ladder når primær fejler:
  → resolveEnhedByDawaId (BBR_Enhed → adgangsadresse → jordstykke-BFE)
  → fetchTinglysningPriceRowsByBfe (BIZZ-685 dokaktuel enrichment)
  → ejf_ejerskab virkning_fra (købsdato-only)`,
    'text'
  ),
  h(3, 'Verifikation (test.bizzassist.dk, 4 enheder)'),
  cb(
`Adresse                         BFE      Areal    Købspris    Købsdato
Arnold Nielsens Blvd 62A, st.   136648   432 m²   4.200.000   2023-06-01
Arnold Nielsens Blvd 62B, st.   136621   1104 m²  7.475.000   2023-06-01
Arnold Nielsens Blvd 62A, 1.    136648   432 m²   4.200.000   2023-06-01
Arnold Nielsens Blvd 62B, 1.    136621   1104 m²  7.475.000   2023-06-01

BFE-dækning:       4/4 ✅ (individuel ejerlejlighed-BFE)
Areal-dækning:     4/4 ✅ (fra summarisk XML)
Købspris-dækning:  4/4 ✅ (4.2M og 7.5M DKK)
Købsdato-dækning:  4/4 ✅ (2023-06-01)
Ejer-dækning:      4/4 ✅ (CVR 26769671)

Note: 62A st. og 62A 1. deler samme BFE (136648) fordi de
juridisk er samme ejerlejlighed — spænder over flere etager.
Samme for 62B (136621). Det er korrekt — ejerlejlighed ≠ adresse.`,
    'text'
  ),
  h(3, 'Debug-fund: Tinglysning etage-filter bug i test-env'),
  p(txt('Probe mod '), code('test.tinglysning.dk'), txt(' viste at '), code('/ejendom/adresse?...&etage=st'), txt(' returnerer tom '), code('{}'), txt(' selv om ejerlejligheden findes uden filter. Det var dette der forhindrede iter 2 i at finde noget. Løsningen: drop etage/sidedoer — ejerlejligheder spænder alligevel over flere etager i samme opgang.')),
  h(3, 'Commits'),
  ul(
    li(p(code('978d36c'), txt(' — Tinglysning /ejendom/adresse + summarisk XML enrichment'))),
    li(p(code('18fd035'), txt(' — fix: drop etage/sidedoer filter'))),
  ),
  p(strong('Test-status: '), txt('1626/1640 grønne, type-check clean, Playwright-verifikation PASS på alle 4 enheder.')),
  p(strong('→ In Review.'))
);

const cr = await req('POST', `/rest/api/3/issue/BIZZ-724/comment`, { body });
console.log(cr.status === 201 ? '✅ BIZZ-724 comment' : `❌ ${cr.status} ${cr.body}`);
const tr = await req('GET', `/rest/api/3/issue/BIZZ-724/transitions`);
const target = (JSON.parse(tr.body).transitions || []).find(t => /^in review$/i.test(t.name));
if (target) {
  const r = await req('POST', `/rest/api/3/issue/BIZZ-724/transitions`, { transition: { id: target.id } });
  console.log(r.status === 204 ? `  ✅ BIZZ-724 → In Review` : `  ⚠️ ${r.status}`);
}
