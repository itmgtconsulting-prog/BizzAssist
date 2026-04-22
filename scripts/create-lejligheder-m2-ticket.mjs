#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
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
    summary: 'Personligt ejede lejligheder viser Bolig: 0 m² på person-side',
    labels: ['bug', 'bbr', 'ejerlejlighed', 'person-page', 'bolig-m2'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Problem'),
        p(
          txt('På person-siden ('),
          code('/dashboard/owners/4000115446'),
          txt(' — Jakob Juul Rasmussen) under Ejendomme-tab viser ALLE "Ejerlejlighed"-typer '),
          code('Bolig: 0 m²'),
          txt(' — mens "Ejerbolig"-typer viser korrekte m²-tal. Data-lookup må ramme forkert BBR-felt for ejerlejligheder.')
        ),
        h(2, 'Observeret (fra Jakobs person-side)'),
        ul(
          li(
            p(
              strong('Forkert (0 m²) — Ejerlejlighed-badge: '),
            ),
            ul(
              li(p(code('Thorvald Bindesbølls Plads 18, 1799 København V'), txt(' · BFE 100.165.718 · '), strong('Bolig: 0 m²'), txt(' · Erhv: 0 m² · Matr: 0 m²'))),
              li(p(code('Horsekildevej 26, 2.tv, 2500 Valby'), txt(' · BFE 173.448 · '), strong('Bolig: 0 m²'))),
              li(p(code('J.C. Jacobsens Gade 11, 5.th, 1799 København V'), txt(' · BFE 100.435.372 · '), strong('Bolig: 0 m²')))
            )
          ),
          li(
            p(
              strong('Korrekt (>0 m²) — Ejerbolig/Enfamilie-badge:')
            ),
            ul(
              li(p(code('Kildegårdsvej 18D, 2900 Hellerup'), txt(' · BFE 100.065.801 · Bolig: 140 m² · Matr: 120 m² ✓'))),
              li(p(code('H C Møllersvej 21, 3730 Nexø'), txt(' · BFE 5.157.134 · Bolig: 166 m² · Matr: 2.600 m² ✓'))),
              li(p(code('Hovager 8, 2650 Hvidovre'), txt(' · BFE 2.024.847 · Bolig: 30 m² (?) · Matr: 300 m² — skal verificeres')))
            )
          )
        ),
        p(
          strong('Mønster: '),
          txt('Alle 3 ejerlejligheder har '),
          code('Bolig: 0 m²'),
          txt('. Det kan ikke være korrekt — ejerlejligheder har pr. definition et boligareal i BBR.')
        ),
        h(2, 'Sandsynlig rodårsag'),
        ul(
          li(
            p(
              txt('Data-lookup sker mod '),
              code('BBR.enhed.samletAreal'),
              txt(' via BFE, men ejerlejligheder har deres BBR-areal registreret under '),
              code('BBR.enhed.boligareal'),
              txt(' eller separat '),
              code('Ejerlejlighed.tinglystAreal'),
              txt(' — mapping rammer forkert felt.')
            )
          ),
          li(
            p(
              txt('Alternativt: BFE for ejerlejligheden er '),
              strong('ejerlejlighedens egen BFE'),
              txt(' (ikke hoved-BFE for bygningen), og vores BBR-kode leder kun efter bygnings-areal under hoved-BFE. Kræver drill-down fra ejerlejligheds-BFE til hoved-BFE.')
            )
          ),
          li(
            p(
              txt('Eller: '),
              code('/api/ejerskab/person-properties'),
              txt(' returnerer BFE-numre, men ejendomskort på person-tab beriger ikke med BBR-data for ejerlejligheds-type.')
            )
          )
        ),
        h(2, 'Reproduktion'),
        ul(
          li(p(txt('Åbn '), code('/dashboard/owners/4000115446'), txt(' → Ejendomme-tab.'))),
          li(p(txt('Scroll til ejerlejligheder-kort (Thorvald Bindesbølls Plads, Horsekildevej, J.C. Jacobsens Gade).'))),
          li(p(txt('Notér Bolig: 0 m² — sammenlign med Kildegårdsvej 18D som viser 140 m² korrekt.'))),
          li(
            p(
              txt('Kryds-verificér mod '),
              code('tinglysning.dk'),
              txt(' eller '),
              code('bbr.dk'),
              txt(' — ejerlejlighederne har reelt 70-100 m² boligareal.')
            )
          )
        ),
        h(2, 'Acceptance criteria'),
        ul(
          li(p(txt('Ejerlejligheder på person-siden viser korrekt Bolig m² (>0) hentet fra BBR/Ejerlejligheds-registret.'))),
          li(p(txt('Samme fix anvendes på ejendoms-detaljesiden og virksomhedssidens Ejendomme-tab hvor relevant.'))),
          li(p(txt('Ingen regression på Ejerbolig-typer der allerede rendreres korrekt.')))
        ),
        h(2, 'Relateret'),
        ul(
          li(p(code('BIZZ-596'), txt(' — tidligere bolig-m² bug på virksomhedsside (nu Done).'))),
          li(p(code('BIZZ-686'), txt(' — personligt ejede ejendomme på person-siden (denne ticket er en follow-up på data-komplethed).')))
        ),
      ],
    },
  },
};
const r = await req('POST', '/rest/api/3/issue', body);
if (r.status !== 201) {
  console.error('fail', r.status, r.body.slice(0, 300));
  process.exit(1);
}
const key = JSON.parse(r.body).key;
console.log('✅', key, '— lejligheder bolig m² oprettet (To Do, Medium)');
