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

const body = {
  fields: {
    project: { key: 'BIZZ' },
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    summary: 'Salgshistorik viser tomme købere og købesummer på Kaffevej 31, 1.tv',
    labels: ['bug', 'ejendom-page', 'oekonomi', 'salgshistorik', 'ejerlejlighed'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Problem'),
        p(
          txt('Salgshistorik-tabellen på ejendomssiden ('),
          code('/dashboard/ejendomme/425479'),
          txt(' — Kaffevej 31, 1.tv, Ejerlejlighed, BFE 425479) viser '),
          strong('4 rækker med stort set kun tomme felter'),
          txt('. Kun én række har købernavn, og '),
          strong('0 ud af 4 rækker har købesum'),
          txt('.')
        ),
        h(2, 'Observeret data (fra mobile-screenshot 22:52, test.bizzassist.dk)'),
        p(
          strong('Salgshistorik på Økonomi-tab:'),
        ),
        ul(
          li(p(code('15. apr. 2023'), txt(' | KØBER: '), code('JAJR Ejendomme ApS (CVR 26316804)'), txt(' | TYPE: 10 (50%) | '), strong('KØBESUM: —'))),
          li(p(code('15. apr. 2023'), txt(' | KØBER: '), code('—'), txt(' | TYPE: 10 (50%) | '), strong('KØBESUM: —'))),
          li(p(code('15. apr. 2023'), txt(' | KØBER: '), code('—'), txt(' | TYPE: 30 (100%) | '), strong('KØBESUM: —'))),
          li(p(code('feb. 2019'), txt(' | KØBER: '), code('—'), txt(' | TYPE: 30 (100%) | '), strong('KØBESUM: —')))
        ),
        h(2, 'Problemer'),
        ul(
          li(
            p(
              strong('Alle 4 købesummer er tomme ('),
              code('—'),
              txt(').')
            )
          ),
          li(
            p(
              strong('3 ud af 4 købere er tomme. '),
              txt('Kun første række har JAJR Ejendomme ApS, selvom 3 rækker har samme dato (15. apr. 2023) — det er sandsynligvis samme overdragelse opsplittet på flere parter/brøker og bør enriches.')
            )
          ),
          li(
            p(
              strong('Type-kode "10" og "30" '),
              txt('vises som rå koder uden beskrivelse. "10" betyder typisk "Almindeligt frit salg", "30" betyder "Familie" eller lignende — oversætning mangler.')
            )
          ),
          li(
            p(
              strong('Duplikat-rækker: '),
              txt('3 rækker på samme dato (15. apr. 2023) med kun procent-forskel. Kan skyldes at samme handel rapporteres flere gange i Tinglysning/EJF, eller at andelshistorikken er split på flere registreringer.')
            )
          )
        ),
        h(2, 'Sandsynlig rodårsag'),
        ul(
          li(
            p(
              txt('Endpoint for salgshistorik ('),
              code('/api/tinglysning/...'),
              txt(' eller '),
              code('/api/ejerskab'),
              txt(') returnerer kun grundlæggende felter og enrichtere ikke ejer-navn + købesum. Købesum hentes typisk fra adkomstdokumentet via Tinglysning, ikke fra ejerskabs-registret.')
            )
          ),
          li(
            p(
              txt('Frontend-mapping viser '),
              code(''),
              txt(' eller '),
              code('null'),
              txt('-værdier som "—" uden at slå manglende felter op via supplerende query til Tinglysning adkomst-endpoint.')
            )
          ),
          li(
            p(
              txt('For ejerlejligheder kan købesummen være registreret under hoved-BFE snarere end ejerlejligheds-BFE — tilsvarende BBR-m²-problem i BIZZ-691.')
            )
          )
        ),
        h(2, 'Acceptance criteria'),
        ul(
          li(p(txt('Salgshistorik viser købesum (DKK) for alle rækker hvor data findes i Tinglysning.'))),
          li(p(txt('Køber-felt enriches med selskabsnavn (via cvr_virksomhed) for CVR-baserede købere og navn for personer.'))),
          li(p(txt('Type-kode oversættes til læsbar tekst (fx "Alm. frit salg", "Familieoverdragelse").'))),
          li(p(txt('Dublet-rækker på samme dato konsolideres eller annoteres tydeligt ("Partiel overdragelse 50% + 50%").'))),
          li(p(txt('Hvis data reelt ikke findes i offentlige registre, vis tooltip "Ingen købesum registreret i Tinglysning" i stedet for bare "—".')))
        ),
        h(2, 'Relateret'),
        ul(
          li(p(code('BIZZ-685'), txt(' (In Progress) — samme bug-familie, Jakob har identificeret som "flere rækker mangler data (koeber, koebesum, kontant, tinglysning)". Denne ticket er konkret reproduktion.'))),
          li(p(code('BIZZ-691'), txt(' — bolig m² mangler på ejerlejligheder (relateret enrichment-problem for ejerlejligheds-type).'))),
          li(p(code('BIZZ-692'), txt(' — selskabsnavn mangler på ejerskab-tab (samme CVR-enrichment-problem).')))
        ),
      ],
    },
  },
};
const r = await req('POST', '/rest/api/3/issue', body);
if (r.status !== 201) { console.error('fail', r.status, r.body.slice(0, 300)); process.exit(1); }
const key = JSON.parse(r.body).key;
console.log('✅', key, '— salgshistorik tomme data oprettet (To Do, Medium)');
// Link to BIZZ-685
const lr = await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key },
  outwardIssue: { key: 'BIZZ-685' },
});
console.log(lr.status === 201 ? `🔗 relates to BIZZ-685` : `link-warn: ${lr.status}`);
