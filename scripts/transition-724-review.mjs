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
  h(2, 'Iteration 2 — matrikel-BFE fallback shipped'),
  p(txt('Reviewer-feedback punkt 1 ('), strong('direct dawaId BBR_Enhed lookup før adgangsadresse'), txt(') + punkt 2 ('), strong('BFE fallback via lokal DB/DAWA'), txt(') adresseret. Punkt 3 (købspris) forbliver blokeret af BIZZ-685/693.')),
  h(3, 'Ny enrichment-pipeline i resolveEnhedByDawaId'),
  cb(
`Step 1: Direct BBR_Enhed match på adresseIdentificerer = dawaId
Step 2: Fallback — probe adgangsadresseid, filtrer children
Step 3: Vurderingsportalen ES (betegnelse + etage/dør match)
Step 4: NY — matrikel-BFE via DAWA
        /adresser/{dawaId} → jordstykke.ejerlav + matrikelnr
        /jordstykker/{ejerlav}/{matrikel} → bfenummer`,
    'text'
  ),
  h(3, 'Verifikation (test.bizzassist.dk, 4 enheder)'),
  cb(
`Adresse                            BFE        Areal   Køber
Arnold Nielsens Blvd 62A, st.      2091165    null    CVR 26769671
Arnold Nielsens Blvd 62B, st.      2091165    200 m²  CVR 26769671
Arnold Nielsens Blvd 62A, 1.       2091165    null    CVR 26769671
Arnold Nielsens Blvd 62B, 1.       2091165    42 m²   CVR 26769671

BFE-dækning:    4/4 ✅ (fra 0/4)
Areal-dækning:  2/4 ✓  (uændret — 62A ikke i BBR_Enhed)
Køber:          4/4 ✅ (via cvr_virksomhed enrichment)`,
    'text'
  ),
  p(strong('Note om matrikel-BFE: '), txt('alle 4 enheder får samme BFE (2091165 = moderjordstykket). Det er '), strong('ikke'), txt(' den ejerlejligheds-specifikke BFE, men det lader downstream salgshistorik-opslag + enrichment-kald fungere uden tom ejendomsreference. Den korrekte ejerlejligheds-BFE ville kræve at BBR_BPFG eller Tinglysning matrikelsøgning dækker 62A, hvilket de ikke gør i øjeblikket for erhvervsenhederne.')),
  h(3, 'Commits'),
  ul(
    li(p(code('6c98c9d'), txt(' — matrikel-bfe fallback (første forsøg, men '), code('struktur=mini'), txt(' strippede jordstykke).'))),
    li(p(code('60c5309'), txt(' — chained /adresser → /jordstykker lookup (virker).'))),
  ),
  p(strong('→ In Review.'), txt(' 1607 tests grønne, type-check grøn, Playwright-verifikation PASS.'))
);

const cr = await req('POST', `/rest/api/3/issue/BIZZ-724/comment`, { body });
console.log(cr.status === 201 ? '✅ BIZZ-724 comment' : `❌ ${cr.status} ${cr.body}`);
const tr = await req('GET', `/rest/api/3/issue/BIZZ-724/transitions`);
const transitions = JSON.parse(tr.body).transitions || [];
console.log('Available:', transitions.map(t => t.name).join(', '));
const target = transitions.find(t => /^in review$/i.test(t.name)) || transitions.find(t => /review/i.test(t.name));
if (target) {
  const r = await req('POST', `/rest/api/3/issue/BIZZ-724/transitions`, { transition: { id: target.id } });
  console.log(r.status === 204 ? `  ✅ BIZZ-724 → ${target.name}` : `  ⚠️ ${r.status} ${r.body}`);
}
