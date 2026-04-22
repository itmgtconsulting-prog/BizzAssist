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
    summary: 'Regression: hovedejendom viser ikke liste over ejerlejligheder — Arnold Nielsens Boulevard 62A',
    labels: ['bug', 'regression', 'hovedejendom', 'ejerlejlighed', 'ejerskab', 'ejendom-page'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Problem'),
        p(
          txt('På hovedejendommen '),
          code('Arnold Nielsens Boulevard 62A, 2650 Hvidovre'),
          txt(' (BFE 226630, ESR 167-2803) under Ejerskab-tab står blot teksten '),
          code('"Ejendommen er opdelt i ejerlejligheder. Ejerskab er registreret på de enkelte ejerlejligheder."'),
          txt(' — uden nogen liste over de underliggende ejerlejligheder.')
        ),
        p(
          strong('Dette er en regression. '),
          txt('BIZZ-362 ("Ejerskab-fanen for hovedejendom bør vise liste over ejerlejligheder med ejere") blev tidligere markeret Done, men funktionaliteten er ikke længere synlig i den nuværende build.')
        ),
        h(2, 'Observeret (test.bizzassist.dk, mobile 23:00)'),
        ul(
          li(p(code('URL: /dashboard/ejendomme/226630'))),
          li(p(txt('Badges: Hovedejendom · Ejerlejlighed · Erhverv'))),
          li(p(txt('Tab-valg: Ejerskab'))),
          li(
            p(
              strong('Indhold: '),
              txt('Kun tom "Ejerstruktur"-card med generisk besked "Ejendommen er opdelt i ejerlejligheder" og ikon. Ingen liste, ingen links, ingen ejere.')
            )
          )
        ),
        h(2, 'Forventet adfærd (per BIZZ-362 + BIZZ-607)'),
        ul(
          li(p(txt('Liste over alle ejerlejligheder tilknyttet hovedejendommen.'))),
          li(p(txt('For hver ejerlejlighed: adresse (inkl. etage + dør), BFE, nuværende ejer (navn + CVR/person), ejerandel.'))),
          li(p(txt('Klik på en ejerlejlighed → navigerer til den specifikke ejerlejligheds-side.'))),
          li(p(txt('Opsummering: "N ejerlejligheder" + eventuelt ejere-total.')))
        ),
        h(2, 'Sandsynlig rodårsag'),
        ul(
          li(
            p(
              txt('Drill-down i EJF: '),
              code('EJFCustom_EjerskabBegraenset(bestemtFastEjendomBFENr: <hovedBFE>)'),
              txt(' returnerer muligvis ikke liste over underliggende lejligheder — kræver måske en '),
              code('EJFCustom_EjerlejlighedSamling'),
              txt('-query eller traversal via '),
              code('grundBFE'),
              txt(' → tilknyttede ejerlejligheds-BFEer.')
            )
          ),
          li(
            p(
              txt('Alternativ: '),
              code('ejf_ejerskab'),
              txt('-tabellen (local) kan bruges til at finde alle rows hvor bygningens jordstykke eller hovedBFE-reference matcher. Kræver join på '),
              code('hovedejendom_bfe'),
              txt('-felt hvis det findes, ellers DAWA jordstykke → adresse-baseret lookup.')
            )
          ),
          li(
            p(
              txt('Frontend-komponent: '),
              code('EjendomEjerforholdTab.tsx'),
              txt(' renderer pt. kun "opdelt i ejerlejligheder"-besked — men mangler at kalde en API der henter underliggende enheder.')
            )
          )
        ),
        h(2, 'Reproduktion'),
        ul(
          li(p(txt('Åbn '), code('https://test.bizzassist.dk/dashboard/ejendomme/226630'), txt(' (Arnold Nielsens Boulevard 62A)'))),
          li(p(txt('Klik Ejerskab-tab'))),
          li(p(txt('Observér: kun tom ejerstruktur-card uden lejligheds-liste'))),
          li(p(txt('Til sammenligning: andre hovedejendomme viste tidligere (BIZZ-362 Done) en komplet liste med alle lejligheder + ejere')))
        ),
        h(2, 'Acceptance criteria'),
        ul(
          li(p(txt('Hovedejendom-ejerskab-tab viser list over ejerlejligheder (adresse, BFE, ejer, andel).'))),
          li(p(txt('Klik på ejerlejligheds-række navigerer til '), code('/dashboard/ejendomme/<lejlighed-BFE>'), txt('.'))),
          li(p(txt('Load-state: spinner/skeleton mens data hentes — ikke tom card.'))),
          li(p(txt('Hvis ingen underliggende lejligheder findes: vis "Ingen registrerede ejerlejligheder" (ikke bare "opdelt i ejerlejligheder").'))),
          li(p(txt('Performance: for store bygninger (fx 50+ lejligheder) paginér eller virtualisér listen.')))
        ),
        h(2, 'Relateret'),
        ul(
          li(p(code('BIZZ-362'), txt(' (Done, 2026-03) — original implementation. Regression skal undersøges: evt. tabt under refactor BIZZ-657/658.'))),
          li(p(code('BIZZ-607'), txt(' (Done) — link fra lejlighed til hovedejendom og retur.'))),
          li(p(code('BIZZ-576'), txt(' (Done) — EJF drill-down returnerer ejerlejlighed-BFE i stedet for hovedejendom-BFE.'))),
          li(p(code('BIZZ-608'), txt(' (Done) — adressesøgning viser både ejerlejlighed og hovedejendom.')))
        ),
      ],
    },
  },
};
const r = await req('POST', '/rest/api/3/issue', body);
if (r.status !== 201) { console.error('fail', r.status, r.body.slice(0, 300)); process.exit(1); }
const key = JSON.parse(r.body).key;
console.log('✅', key, '— hovedejendom regression oprettet (To Do, Medium)');
// Link to BIZZ-362
const lr = await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key },
  outwardIssue: { key: 'BIZZ-362' },
});
console.log(lr.status === 201 ? `🔗 relates to BIZZ-362` : `link-warn: ${lr.status}`);
