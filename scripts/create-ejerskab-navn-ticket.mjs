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
    summary: 'Ejerskab-tab på ejendomsside: selskabsnavn mangler som overskrift (viser kun CVR-nummer)',
    labels: ['bug', 'ejendom-page', 'ejerskab', 'ux', 'navn-enrichment'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Problem'),
        p(
          txt('På ejendomsdetaljesidens '),
          code('Ejerskab'),
          txt('-tab vises ejer-kortet med '),
          code('CVR 26316804 (100%)'),
          txt(' som overskrift — '),
          strong('selskabets navn mangler'),
          txt('. Brugeren må klikke ind på CVR-linket for at se hvilket selskab det er.')
        ),
        h(2, 'Observeret (Kaffevej 31, 1.tv, BFE 425479)'),
        ul(
          li(p(
            strong('Nuværende: '),
            code('CVR 26316804 (100%)'),
            txt(' — ingen læsbar overskrift'),
          )),
          li(p(
            strong('Forventet: '),
            code('JAJR Ejendomme ApS'),
            txt(' (som overskrift) + CVR 26316804 + 100% som sekundær info')
          )),
          li(p(
            strong('Metadata der er til rådighed: '),
            txt('Overtagelsesdato 15. april 2023 · Ejertype Selskab vises fint — kun navnet mangler.')
          ))
        ),
        h(2, 'Konsistens-mangel'),
        p(
          txt('Andre steder i UI viser ejer med selskabsnavn som overskrift:'),
        ),
        ul(
          li(p(txt('Virksomhedsside → Ejendomme-tab: ejendommen vises med adresse + ejer-selskab som label.'))),
          li(p(txt('Person-side → Ejendomme-tab: ejendomme listes med addresse + BFE.'))),
          li(p(txt('Ejerskabsdiagram: selskabs-noder har navn som overskrift.'))),
          li(p(strong('Kun '), code('/dashboard/ejendomme/[id]'), strong(' → Ejerskab-tab'), txt(' viser kun CVR-nummeret.')))
        ),
        h(2, 'Sandsynlig rodårsag'),
        p(
          txt('Komponenten der rendrer ejer-kortet på ejerskab-tab (sandsynligvis '),
          code('EjendomEjerforholdTab.tsx'),
          txt(' eller lignende) enrichterer ikke CVR→navn — måske fordi den bruger '),
          code('/api/ejerskab'),
          txt('-response direkte uden at slå navne op via '),
          code('/api/cvr-public'),
          txt(' eller '),
          code('cvr_virksomhed'),
          txt('-tabellen.')
        ),
        h(2, 'Fix-forslag'),
        ul(
          li(p(
            strong('Kortsigtet: '),
            txt('I ejerskab-komponenten, for hver ejer med '),
            code('ejertype=selskab'),
            txt(' + '),
            code('cvr'),
            txt(', slå op i '),
            code('cvr_virksomhed'),
            txt('-tabel (lokal, hurtig) og vis '),
            code('navn'),
            txt(' som H1 + '),
            code('CVR xxx • 100%'),
            txt(' som sekundær linje.')
          )),
          li(p(
            strong('Medium-sigt: '),
            txt('Endpointet '),
            code('/api/ejerskab'),
            txt(' kunne returnere '),
            code('virksomhedsnavn'),
            txt(' i response-shape (det gjorde det faktisk i den revertede DB-first-version per BIZZ-681-683). Konsistent enrichment i backend ville løse alle klient-konsumenter på én gang.')
          ))
        ),
        h(2, 'Reproduktion'),
        ul(
          li(p(
            txt('Åbn '),
            code('test.bizzassist.dk/dashboard/ejendomme/425479'),
            txt(' (Kaffevej 31, 1.tv)')
          )),
          li(p(txt('Klik Ejerskab-tab'))),
          li(p(
            txt('Observer: øverste ejer-kort viser kun '),
            code('CVR 26316804 (100%)'),
            txt(' — ingen selskabsnavn.')
          ))
        ),
        h(2, 'Acceptance criteria'),
        ul(
          li(p(txt('Selskabs-ejere vises med navn som overskrift på ejendomssidens Ejerskab-tab.'))),
          li(p(txt('Person-ejere vises med personens navn som overskrift (bør allerede virke — tjek konsistens).'))),
          li(p(txt('CVR-nummer + ejerandel vises som sekundær information (fx grå tekst nedenunder).'))),
          li(p(txt('Virker for både aktuelle og historiske ejere (ved "Vis historik"-toggle jf. BIZZ-569/580).'))),
          li(p(txt('Ingen ekstra N+1 API-kald ved mange ejere — batch cvr-lookup via '), code('cvr IN (...)'), txt(' mod '), code('cvr_virksomhed'), txt('.')))
        ),
        h(2, 'Relateret'),
        ul(
          li(p(code('BIZZ-683'), txt(' — diagram virksomhedsnavn-enrichment (samme underliggende enrichment-problem).'))),
          li(p(code('BIZZ-651/680'), txt(' — lokal cvr_virksomhed-tabel er tilgængelig med raw_source + navn-felt.')))
        ),
      ],
    },
  },
};
const r = await req('POST', '/rest/api/3/issue', body);
if (r.status !== 201) { console.error('fail', r.status, r.body.slice(0, 300)); process.exit(1); }
console.log('✅', JSON.parse(r.body).key, '— ejerskab-selskabsnavn oprettet (To Do, Medium)');
