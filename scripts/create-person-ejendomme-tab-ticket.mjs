#!/usr/bin/env node
/**
 * Creates JIRA ticket for missing personally owned properties on person's
 * Ejendomme-tab.
 *
 * Rapporteret 2026-04-20 af bruger efter BIZZ-534 seed: Jakob Juul Rasmussens
 * Ejendomme-tab viser ikke hans personligt ejede ejendomme (kun virksomheders).
 * Bulk-data-sporet skal integreres her på samme måde som på diagram-tabben.
 *
 * Run: node scripts/create-person-ejendomme-tab-ticket.mjs
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

const description = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'Baggrund'),
    p(
      'Rapporteret 2026-04-20 af bruger efter BIZZ-534 er merged og test.bizzassist.dk er fuldt seedet (~7.6M records i ejf_ejerskab).'
    ),
    h(2, 'Observation'),
    p(
      'Person-detaljeside → ',
      { type: 'text', text: 'Ejendomme-tab', marks: [{ type: 'strong' }] },
      ' for Jakob Juul Rasmussen viser IKKE hans personligt ejede ejendomme. Kun ejendomme ejet af Jakobs virksomheder (via hans holding-struktur) vises.'
    ),
    h(2, 'Forventet'),
    p('Ejendomme-tabben skal vise BÅDE:'),
    bullets([
      'Virksomhedsejede ejendomme (via CVR → ejendomme-by-owner) — p.t. implementeret',
      'Personligt ejede ejendomme (via bulk-data ejf_ejerskab) — MANGLER',
    ]),
    p('Jakob har 9 gældende personligt ejede ejendomme i public.ejf_ejerskab som skal vises.'),
    h(2, 'Datagrundlag'),
    code(
      `BFE          Ejerandel  Adresse
2.081.243    1/2 (50%)  Søbyvej 11, 2650 Hvidovre (delt med Kamilla)
167.448      1/1        Vigerslevvej 146
10.133.930   1/1        (adresse via DAWA)
100.165.718  1/1        (adresse via DAWA)
5.157.134    1/1        H C Møllersvej 21, 3730 Nexø
173.448      1/1        Horsekildevej 26
100.065.801  1/1        Hovager 8
100.435.372  1/2 (50%)
2.024.847    1/2 (50%)  Hovager 8`
    ),
    h(2, 'Opgave'),
    h(3, '1. Data-kilde'),
    p(
      'Ligesom DiagramForce kalder /api/ejerskab/person-bridge + /api/ejerskab/person-properties + /api/bfe-addresses, skal Person-Ejendomme-tab gøre det samme ved mount.'
    ),
    h(3, '2. UI-integration'),
    bullets([
      'Mergér virksomhedsejede (fra ejendomme-by-owner?cvrs=...) og personligt ejede (fra bulk-data) i samme liste/grid',
      'Marker personligt ejede med badge/label (fx "Personligt ejet" eller "Privat") så brugeren kan se forskel',
      'Sortér: aktive først, derefter solgte/historiske',
      'Vis ejerandel (1/1, 1/2 osv.) som kolonne ligesom på virksomheds-fanen',
      'Fold ud til detaljer (adresse, BFE, virkning_fra, ejendomstype)',
    ]),
    h(3, '3. Layout alignment'),
    p(
      'Skal matche virksomheds-fanens layout (horisontal grid, udvidede datafelter — se BIZZ-569 for reference) så visning er konsistent på tværs af person- og virksomheds-detaljesider.'
    ),
    h(2, 'Acceptance criteria'),
    bullets([
      'Jakobs Ejendomme-tab viser 9 personligt ejede + alle virksomhedsejede ejendomme',
      'Ejerandel vises korrekt på både 100%-ejede og 50%-ejede (Søbyvej 11 = 50%)',
      'Personligt ejede har visuel markør der adskiller dem fra virksomheds-ejede',
      'Ingen duplikering hvis samme BFE fremkommer begge steder (unlikely men defensivt)',
      'Mobil + desktop layout fungerer',
    ]),
    h(2, 'Relaterede tickets'),
    bullets([
      'BIZZ-534 — EJF bulk-ingestion (merged, seed komplet på preview)',
      'BIZZ-594 — Person-diagram: samme bulk-data mangler på diagram-tabben',
      'BIZZ-580 — Person→Ejendomme layout alignment med virksomheds-fanen',
      'BIZZ-569 — Virksomhed→Ejendomme horisontal grid (reference-layout)',
    ]),
    h(2, 'Testdata'),
    p(
      'enhedsNummer=4000115446 (Jakob), navn=Jakob Juul Rasmussen, fdato=1972-07-11. Relevante BFEs listet ovenfor.'
    ),
  ],
};

const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary: 'Person → Ejendomme-tab: personligt ejede ejendomme vises ikke',
    description,
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    labels: ['person', 'ejendomme', 'ejf', 'bulk-data', 'ui'],
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
