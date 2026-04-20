#!/usr/bin/env node
/**
 * Creates JIRA ticket for two bugs on person-diagram tab:
 *  1. Personligt ejede ejendomme vises ikke fuldt på person-diagrammet
 *     (Jakob har 9 gældende ejendomme, kun 2 vises på hans diagram-tab)
 *  2. Ejerandel vises forkert for Kamilla Kofoed Led
 *
 * Rapporteret af bruger 2026-04-20 via screenshot fra test.bizzassist.dk på mobil.
 *
 * Run: node scripts/create-person-diagram-bugs-ticket.mjs
 */

import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'BIZZ';

if (!EMAIL || !TOKEN) {
  console.error('Missing JIRA_EMAIL or JIRA_API_TOKEN in .env.local');
  process.exit(1);
}

const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ─── ADF builders ─────────────────────────────────────────────────────────
const p = (...nodes) => ({
  type: 'paragraph',
  content: nodes.map((n) => (typeof n === 'string' ? { type: 'text', text: n } : n)),
});
const h = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const bullets = (items) => ({
  type: 'bulletList',
  content: items.map((item) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
  })),
});
const code = (text, lang = 'text') => ({
  type: 'codeBlock',
  attrs: { language: lang },
  content: [{ type: 'text', text }],
});

// ─── Ticket body ──────────────────────────────────────────────────────────
const description = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'Baggrund'),
    p(
      'Rapporteret 2026-04-20 af bruger via screenshot fra test.bizzassist.dk (mobil-visning). Efter BIZZ-534 er seedet fuldt på preview er person-diagrammet for Jakob Juul Rasmussen synligt, men der er to uafhængige problemer.'
    ),
    h(2, 'Bug 1: Personligt ejede ejendomme mangler på person-diagrammet'),
    h(3, 'Observation'),
    p(
      'På Jakob Juul Rasmussens person-detaljeside → Diagram-tab vises kun ',
      { type: 'text', text: '2 personligt ejede ejendomme', marks: [{ type: 'strong' }] },
      ' som grønne noder direkte på hans person-node:'
    ),
    bullets([
      'H C Møllersvej 21, 3730 Nexø (BFE 5.157.134)',
      'Søbyvej 11, 2650 Hvidovre (BFE 2.081.243)',
    ]),
    h(3, 'Forventet'),
    p(
      'Jakob har 9 gældende + 1 historisk ejerskaber i public.ejf_ejerskab. Alle 9 gældende bør vises på diagrammet (samme data-kilde som på virksomheds-diagrammet, hvor det FUNGERER korrekt — ',
      { type: 'text', text: 'bekræftet samme dag', marks: [{ type: 'em' }] },
      ' på JAJR Ejendomme 2 ApS → Diagram hvor alle 9 Jakob-ejendomme vises efter klik på Udvid).'
    ),
    h(3, 'Jakobs faktiske 9 gældende BFEs (fra ejf_ejerskab)'),
    code(
      `BFE          Ejerandel  Virkning fra
2.081.243    1/2 (50%)  2003-04-23  ← Søbyvej 11
167.448      1/1        2005-03-20  ← Vigerslevvej 146
10.133.930   1/1        2008-06-19
100.165.718  1/1        2019-06-24
5.157.134    1/1        2020-07-03  ← H C Møllersvej 21
173.448      1/1        2021-06-09
100.065.801  1/1        2021-07-31
100.435.372  1/2 (50%)  2022-05-14
2.024.847    1/2 (50%)  2022-07-24`
    ),
    h(3, 'Analyse'),
    p(
      'På virksomheds-diagrammet kaldes person-bridge + person-properties + bfe-addresses via expandPersonDynamic når brugeren klikker "▸ Udvid". På person-diagrammet er personen ',
      { type: 'text', text: 'allerede root-noden (isMain=true)', marks: [{ type: 'strong' }] },
      ', så udvidelsen burde ske automatisk ved load — enten via initial-load eller ved at auto-expande root-personen.'
    ),
    p(
      'Tilstanden matcher 2 ejendomme. Disse er sandsynligvis hentet fra en ANDEN kilde (fx ejendomme-by-owner via enhedsNummer, som kun matcher EJF-records der eksplicit har Jakobs enhedsNummer = 4000115446). Bulk-data-sporet (person-bridge → person-properties) fyrer ikke på person-siden.'
    ),
    h(3, 'Foreslået fix'),
    bullets([
      'På person-diagrammet (eller via page-init): kald expandPersonDynamic automatisk for root-person-noden',
      'Alternativt: buildDiagramGraph for personer kan pre-fetche person-properties og inkludere BFEs direkte i graph.nodes',
      'Verificer at alle 9 BFEs vises uden manuel "Udvid"-klik',
    ]),
    h(2, 'Bug 2: Forkert ejerandel vises for Kamilla Kofoed Led'),
    h(3, 'Observation'),
    p(
      'Kamilla Kofoed Led ejer 50% af Søbyvej 11 (BFE 2.081.243) sammen med Jakob. Screenshot viser at hendes andel vises forkert et eller andet sted på diagrammet — andel er enten fejlregistreret eller misbereget.'
    ),
    h(3, 'Forventet'),
    p(
      'Hendes edge fra person-node til Søbyvej 11 skal vise "50%" (matcher ejerandel_taeller/ejerandel_naevner = 1/2 i ejf_ejerskab).'
    ),
    h(3, 'Mulige årsager'),
    bullets([
      'BIZZ-585 hard-codede 100% på bulk-data edges — overrider den faktiske ejerandel fra ejf_ejerskab',
      'person-properties route returnerer kun bfe-liste, ikke ejerandel — så klienten har ikke andel-data tilgængelig',
      'Kamilla vises via anden kode-sti (ikke via bulk-data) og har anden ejerandel-beregning',
    ]),
    h(3, 'Foreslået fix'),
    bullets([
      'Udvid /api/ejerskab/person-properties til at returnere { bfe, ejerandel_taeller, ejerandel_naevner } i stedet for blot bfes[]',
      'I DiagramForce expandPersonDynamic: beregn ejerandel-procent fra returnerede brøker i stedet for hard-coded 100%',
      'Verificer både Jakob og Kamilla viser 50% på Søbyvej 11 (BFE 2.081.243)',
    ]),
    h(2, 'Acceptance criteria'),
    bullets([
      'Person-diagram for Jakob Juul Rasmussen viser alle 9 gældende ejendomme uden manuel "Udvid"',
      'Ejerandel på kanter matcher ejerandel_taeller/ejerandel_naevner fra ejf_ejerskab',
      'Specifik verificering: Søbyvej 11 viser 50% på både Jakobs og Kamillas edges',
      'Ingen regression på virksomheds-diagrammet (100% default når ejerandel mangler)',
    ]),
    h(2, 'Relaterede tickets'),
    bullets([
      'BIZZ-534 — EJF bulk-ingestion (verificeret på virksomheds-diagram, men person-diagram mangler)',
      'BIZZ-586 — Person-diagram root-node fold-ud',
      'BIZZ-585 — 100% ejerandel på bulk-data edges (OPRINDELIG kilde til Bug 2)',
      'BIZZ-580 — Person→Ejendomme layout alignment',
    ]),
    h(2, 'Testdata'),
    p(
      'enhedsNummer=4000115446 (Jakob), navn=Jakob Juul Rasmussen, fdato=1972-07-11. Søbyvej 11 BFE=2081243. Kamilla ejer matchende 50%.'
    ),
  ],
};

// ─── Create ticket ────────────────────────────────────────────────────────
const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary: 'Person-diagram: ejendomme mangler + forkert ejerandel for medejere',
    description,
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    labels: ['diagram', 'person', 'ejf', 'ejerandel', 'bulk-data'],
  },
};

const created = await req('POST', '/rest/api/3/issue', payload);
if (created.status !== 201) {
  console.error('Create failed:', created.status, created.body);
  process.exit(1);
}
const key = JSON.parse(created.body).key;
console.log(`Created: ${key}`);
console.log(`\nDone: https://${HOST}/browse/${key}`);
