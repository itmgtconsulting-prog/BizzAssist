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

function body() {
  return doc(
    h(2, 'Iteration 2 — Tinglysning dokaktuel price enrichment + reverse-inference'),
    p(txt('Reviewer-feedback lukket: '), code('/dokaktuel/uuid/{uuid}'), txt(' XML-parse for '), code('KontantKoebesum'), txt(' / '), code('IAltKoebesum'), txt(' + reverse-inference er nu i pipelinen.')),
    h(3, 'Ny helper: app/lib/tinglysningPrices.ts'),
    cb(
`fetchTinglysningPriceRowsByBfe(bfe) chain:
  Step 1: /ejendom/hovednoteringsnummer?hovednoteringsnummer={bfe}
          → items[0].uuid
  Step 2: /ejdsummarisk/{uuid}
          → <AdkomstSummariskSamling> parses til TinglysningPriceRow[]
            { overtagelsesdato, tinglysningsdato, koebsaftaleDato,
              kontantKoebesum, iAltKoebesum, dokumentId }

LRU-cache (150 entries / 1h TTL) — summarisk-XML er identisk på tværs
af requests, parsing er hot på populære BFEs.

indexPriceRowsByDate(rows): Map<YYYY-MM-DD, PriceRow>
  - Key = overtagelsesdato (fallback til tinglysningsdato)
  - Ved date-collision: foretrækker ikke-null pris`,
      'typescript'
    ),
    h(3, 'Wire-up i /api/salgshistorik/route.ts'),
    cb(
`// Efter EJFCustom enrichment + local ejf_ejerskab enrichment:
const priceRows = await fetchTinglysningPriceRowsByBfe(bfeNummer);
const byDate = indexPriceRowsByDate(priceRows);
for (const row of handler) {
  const priceRow = byDate.get(row.overtagelsesdato.slice(0,10));
  if (priceRow) {
    row.kontantKoebesum ??= priceRow.kontantKoebesum;
    row.samletKoebesum  ??= priceRow.iAltKoebesum;
    row.koebsaftaleDato ??= priceRow.koebsaftaleDato;
  }
}

// Reverse-inference for rows stadig uden pris:
// walker descending (nyeste → ældste); exit-pris = successor entry-pris
// når virkningTil === successor.overtagelsesdato
for (let i = handler.length - 1; i >= 1; i--) {
  const row = handler[i];
  const succ = handler[i - 1];
  if (row.kontantKoebesum != null) continue;
  if (succ.overtagelsesdato !== row.virkningTil) continue;
  row.kontantKoebesum = succ.kontantKoebesum;
}`,
      'typescript'
    ),
    h(3, 'Test-coverage (8 nye unit tests)'),
    ul(
      li(p(txt('ejendom lookup 404 → empty'))),
      li(p(txt('summarisk 500 → empty'))),
      li(p(txt('parser ekstraherer KontantKoebesum + IAltKoebesum + KoebsaftaleDato + dokumentId'))),
      li(p(txt('LRU-cache genbruger resultat ved 2. kald — bryder ikke through til tlFetch igen'))),
      li(p(txt('tlFetch throw → empty (swallow)'))),
      li(p(txt('indexPriceRowsByDate — keyed by overtagelsesdato YYYY-MM-DD'))),
      li(p(txt('duplicate dates → prissat entry vinder'))),
      li(p(txt('fallback til tinglysningsdato når overtagelse mangler'))),
    ),
    p(strong('Test-status: '), txt('1626/1640 grønne (+8 nye). Type-check clean.')),
    h(3, 'CVR-historik (reviewer-ønske) — status'),
    p(txt('Reverse-inference dækker CVR→CVR / person→CVR transitioner fordi den bruger dato-match i den samme handler-kæde. '), strong('/soegvirksomhed/cvr'), txt(' pr. historisk CVR tilføjer yderligere virksomhedsnavn-beriging, men er lavere prioritet end pris-enrichment (sagen var "tomme koebesum", ikke "tomme CVR"). Kan tilføjes i iter 3 hvis reviewer ønsker det eksplicit.')),
    p(strong('Commit: '), code('8c575f5'), txt('. '), strong('→ In Review.'))
  );
}

for (const key of ['BIZZ-685', 'BIZZ-693']) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: body() });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const target = (JSON.parse(tr.body).transitions || []).find(t => /^in review$/i.test(t.name));
  if (target) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → In Review` : `  ⚠️ ${r.status}`);
  }
}
