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
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
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

const items = [
  {
    key: 'BIZZ-687',
    transition: 'Done',
    body: [
      h(2, 'Playwright-verifikation — PASS'),
      p(
        txt('JaJR Holding ApS (CVR 41092807) → Diagram-tab viser nu Jakob Juul Rasmussen som person-node '),
        strong('over'),
        txt(' JaJR Holding ApS-boksen.')
      ),
      ul(
        li(p(strong('Evidens: '), txt('Playwright tekst-match "Jakob Juul Rasmussen" i diagram-tab = 3 gange.'))),
        li(
          p(
            strong('Visuelt: '),
            txt('Diagrammet viser kæden '),
            code('Jakob Juul Rasmussen'),
            txt(' (ejer) → '),
            code('JaJR Holding ApS'),
            txt(' → '),
            code('JaJR Holding 2 ApS'),
            txt(' + '),
            code('Pharma IT ManCo ApS'),
            txt(' → datter-selskaber.')
          )
        ),
        li(
          p(
            strong('API-kontrol: '),
            code('GET /api/cvr-public?vat=41092807'),
            txt(' returnerer '),
            code('owners: [{ name: "Jakob Juul Rasmussen" }]'),
            txt(' + '),
            code('deltagerCount: 2'),
            txt('.')
          )
        ),
        li(p(strong('Screenshot: '), code('/tmp/verify-screenshots/687-diagram.png'))),
        li(
          p(
            strong('Sandsynlig fix: '),
            txt('BIZZ-692 commit '),
            code('b26ea6a'),
            txt(' (virksomhedsnavn-label på diagram) eller tidligere EJF-enrichment. Jakobs egen check bekræftede at data var i CVR ES — problem var rendering/label.')
          )
        )
      ),
      p(strong('BIZZ-687 → Done.')),
    ],
  },
  {
    key: 'BIZZ-693',
    transition: 'To Do',
    body: [
      h(2, 'API-level verifikation — FAIL (samme systemiske bug som BIZZ-685)'),
      p(
        strong('Fix er IKKE landet for Kaffevej 31, 1.tv (BFE 425479).'),
        txt(' Testet direkte via '),
        code('/api/salgshistorik?bfeNummer=425479'),
        txt(':')
      ),
      ul(
        li(p(strong('count: '), code('4'), txt(' handler-rows'))),
        li(p(strong('rowsWithKoeber: '), code('0'))),
        li(p(strong('rowsWithKoebesum: '), code('0'))),
        li(p(txt('Response-felter populeret: '), code('overtagelsesdato, overdragelsesmaade, virkningTil'), txt(' — alle andre felter '), code('null'), txt(' (koeber, koebesum, kontantKoebesum, samletKoebesum, loesoeresum, entreprisesum, koebsaftaleDato, skoedetekst, valutakode).')))
      ),
      p(
        strong('Dette er samme bug-familie som '),
        code('BIZZ-685'),
        txt(' (verificeret FAIL på 5 forskellige BFEer): '),
        code('/api/salgshistorik'),
        txt(' kalder ikke '),
        code('EJF_Handelsoplysninger'),
        txt(' for at hente prisdata + køber-info efter trin 1 (EJF_Ejerskifte).')
      ),
      p(
        strong('Jakobs kommentar 23:27: '),
        txt('"Browser-debugging nødvendig for at verificere om EJF-data faktisk modtages." — bekræfter at fix ikke er klart endnu.')
      ),
      p(strong('BIZZ-693 → To Do. '), txt('Arbejdet skal koordineres med BIZZ-685 (samme root cause).')),
    ],
  },
];

for (const { key, transition, body } of items) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: { type: 'doc', version: 1, content: body } });
  console.log(c.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${c.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => x.name.toLowerCase() === transition.toLowerCase());
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `   ✅ ${key} → ${transition}` : `   ⚠️ ${key} ${r.status}`);
  }
}
