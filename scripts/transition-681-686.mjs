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

const items = [
  {
    key: 'BIZZ-681',
    transition: 'Done',
    body: [
      h(2, 'Playwright-verifikation — PASS'),
      p(txt('test.bizzassist.dk / JAJR Ejendomme ApS (CVR 26316804) → Ejendomme-tab: '), strong('6 adresser vises med navn, 0 BFE-only-entries.')),
      ul(
        li(p(txt('Eksempler synlige: Kaffevej 31 1.tv, Arnold Nielsens Boulevard 62/66A/64B, Høvedstensvej 27.'))),
        li(p(txt('Alle ejendomme har også BFE-nummer + ejerlejlighed/erhverv-badge + bolig/erhv m² + grundv/vurd DKK.'))),
        li(p(strong('Screenshot: '), code('/tmp/verify-screenshots/681-ejendomme.png')))
      ),
      p(strong('BIZZ-681 → Done'), txt(' efter revert 7a79eff.')),
    ],
  },
  {
    key: 'BIZZ-682',
    transition: 'Done',
    body: [
      h(2, 'Playwright-verifikation — PASS'),
      p(txt('JAJR Ejendomme ApS → Personer-tab: '), strong('4+ person-referencer synlige'), txt('. Kronologi-tab rendrer uden crash.')),
      ul(
        li(p(strong('Personer: '), txt('ingen "Ingen data"-besked, normale rækker.'))),
        li(p(strong('Screenshots: '), code('682-personer.png'), txt(' + '), code('682-kronologi.png')))
      ),
      p(strong('BIZZ-682 → Done'), txt(' efter revert 7a79eff.')),
    ],
  },
  {
    key: 'BIZZ-683',
    transition: 'Done',
    body: [
      h(2, 'Playwright-verifikation — PASS'),
      p(txt('JAJR Ejendomme ApS → Diagram-tab: '), strong('virksomhedsnavnet "JAJR" synligt i diagrammet.')),
      p(txt('Screenshot: '), code('683-diagram.png'), txt('. Diagrammet rendrer SVG med noder og tekstetiketter.')),
      p(strong('BIZZ-683 → Done'), txt(' efter revert 7a79eff.')),
    ],
  },
  {
    key: 'BIZZ-684',
    transition: 'Done',
    body: [
      h(2, 'Playwright-verifikation — PASS'),
      p(txt('JAJR Ejendomme ApS → Virksomheder-tab: '), strong('4 virksomheds-referencer synlige i hierarkiet'), txt(' (JaJR Holding, datterselskaber, søsterselskaber).')),
      p(txt('Screenshot: '), code('684-virksomheder.png')),
      p(strong('BIZZ-684 → Done'), txt(' efter revert 7a79eff.')),
    ],
  },
  {
    key: 'BIZZ-685',
    transition: 'In Progress',
    body: [
      h(2, 'Playwright-verifikation — INCONCLUSIVE'),
      p(
        strong('Kunne ikke tilgå ejendomsdetaljeside '),
        txt('for 4 testede BFE-numre (2091166 Høvedstensvej 27, 2091180 Arnold Nielsens Boulevard 66B, 226630, 2091185): '),
        code('/dashboard/ejendomme/{BFE}'),
        txt(' returnerer "Ejendom ikke fundet".')
      ),
      ul(
        li(
          p(
            strong('Delvist observeret: '),
            txt('Salgshistorik-felter VISES korrekt i Ejendomme-tabet på virksomhedsside (fx "Købt: 18.5 mio DKK (apr. 2023)" på Høvedstensvej 27-kortet) — så bagvedliggende data er til stede.')
          )
        ),
        li(
          p(
            strong('Blocker: '),
            txt('Separat bug ved BFE-lookup på ejendomsdetaljeside — bør logges som selvstændig ticket før BIZZ-685 kan verificeres.')
          )
        )
      ),
      p(strong('Transitioner til In Progress '), txt('indtil ejendomsdetaljeside kan åbnes.')),
    ],
  },
  {
    key: 'BIZZ-686',
    transition: 'Done',
    body: [
      h(2, 'Visual inspection — PASS'),
      p(strong('Ejendomme-tab på person-siden viser nu alle 9 personligt ejede ejendomme.')),
      h(3, 'Verificeret på test.bizzassist.dk / dashboard/owners/4000115446 → Ejendomme-tab'),
      ul(
        li(p(code('Thorvald Bindesbølls Plads 18'), txt(' · BFE 100.165.718 · Ejerlejlighed ✓'))),
        li(p(code('Horsekildevej 26, 2.tv'), txt(' · BFE 173.448 · Ejerlejlighed ✓'))),
        li(p(code('Kildegårdsvej 18D'), txt(' · BFE 100.065.801 · Ejerbolig ✓'))),
        li(p(code('H C Møllersvej 21'), txt(' · BFE 5.157.134 · Ejerbolig ✓'))),
        li(p(code('J.C. Jacobsens Gade 11, 5.th'), txt(' · BFE 100.435.372 · Ejerlejlighed ✓'))),
        li(p(code('Hovager 8'), txt(' · BFE 2.024.847 · Ejerbolig ✓'))),
        li(p(code('Stårupvej 26'), txt(' · BFE 10.133.930 · Ejerbolig ✓'))),
        li(p(code('Vigerslevvej 146, 1.th'), txt(' ✓'))),
        li(p(code('Søbyvej 11'), txt(' ✓')))
      ),
      p(
        strong('API-verifikation: '),
        code('GET /api/ejerskab/person-properties?navn=Jakob+Juul+Rasmussen&fdato=1972-07-11'),
        txt(' returnerer præcis de 9 BFE-numre som vises i UI — 1:1 match.')
      ),
      h(3, 'Diagram verificeret'),
      p(
        txt('Ejerskabsdiagrammet rendrer også de 9 personligt ejede ejendomme som grønne noder (Thorvald Bindesbølls Plads 18, Horsekildevej 26, Kildegårdsvej 18D, Hovager 8, Stårupvej 26, etc.) — se attached screenshot fra user på /owners/4000115446/diagram.')
      ),
      h(3, 'Data-kompletheds-noter (behandles separat)'),
      ul(
        li(p(code('BIZZ-691'), txt(' oprettet: alle 3 ejerlejligheder (Thorvald Bindesbølls Plads 18, Horsekildevej 26, J.C. Jacobsens Gade 11) viser Bolig: 0 m² — BBR-lookup-bug for ejerlejligheds-type.'))),
        li(p(code('BIZZ-690'), txt(' oprettet: diagram hopper/jitter ved 20+ noder + expand.')))
      ),
      h(3, 'Tidligere FAIL var falsk-negativ'),
      p(
        txt('Min første Playwright-test klikkede sidebar-menuen "Ejendomme" i stedet for tab-knappen med samme tekst. Navigation gik til /dashboard/ejendomme (global søgeside) — ikke person-Ejendomme-tab. Korrigeret via manual user-verification.')
      ),
      p(strong('BIZZ-686 → Done.')),
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
  } else {
    console.log(`   ⚠️ ${key} no "${transition}" transition`);
  }
}
