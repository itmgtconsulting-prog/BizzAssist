#!/usr/bin/env node
/**
 * Creates JIRA ticket: PDF-download på Tinglysning-tab henter kun bilag,
 * ikke selve servitutten.
 *
 * Observeret 2026-04-20 på test.bizzassist.dk på ejendom 0dbd9c5b-10a4-46b4-
 * 970d-4b6ff12fea9a (Thorvald Bindesbølls Plads 18, hovedejendom, BFE 100165662).
 *
 * Run: node scripts/create-pdf-servitut-download-ticket.mjs
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

const description = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'Baggrund'),
    p(
      'Rapporteret 2026-04-20 af bruger via screenshot fra test.bizzassist.dk. På Tinglysning-tab viser hver servitut-række en "PDF"-knap. Klik på PDF-knappen åbner flere faneblade med bilags-PDFer — men ikke selve servitut-dokumentet. Bruger har 4 nye dokument-faner åbnet som beviser adfærden.'
    ),
    h(2, 'Observeret på'),
    bullets([
      'URL: https://test.bizzassist.dk/dashboard/ejendomme/0dbd9c5b-10a4-46b4-970d-4b6ff12fea9a',
      'Ejendom: Thorvald Bindesbølls Plads 18, 1799 København V (hovedejendom)',
      'BFE: 100165662',
      'ESR: 101-17667',
      'Type-badges: Hovedejendom, Ejerlejlighed, Beboelsesejendom, 20 (2017)',
      'Aktiv tab: Tinglysning',
    ]),
    h(2, 'Konkret eksempel — række 13'),
    bullets([
      'Dato: 30. mar. 2016',
      'Titel: DEKLARATION OM TILSLUTNINGS - SAMT AFTAGEPLIGT TIL FJERNKØLING (581 ejd.)',
      'Badge: "3 bilag"',
      'Påtaleberettiget: FREDERIKSBERG FJERNKØLING A/S',
      'Indhold: tilslutningspligt',
      'Afgift: 1.660 DKK',
      'Dok-ID: 20160330-1007182964',
      'Tillægstekst viser 3 ID-referencer: c1ed4713-..., cda5bb05-..., 33895c3c-...',
      'Sektionen "TILKNYTTEDE BILAG (3)" viser 3 links: Bilag, påtegn. 04.04.2016, påtegning 27.11.2018',
    ]),
    h(2, 'Symptom'),
    p(
      'Klik på "PDF"-knappen på række 13 åbner 3-4 browser-faner med bilag-PDFer (påtegning 04.04.2016 + påtegning 27.11.2018 + Bilag). Selve servitut-PDFen (hovedokumentet "DEKLARATION OM TILSLUTNINGS..." identificeret ved Dok 20160330-1007182964) downloades/åbnes IKKE.'
    ),
    p('Samme adfærd observeret på flere servitut-rækker — ikke kun række 13.'),
    h(2, 'Forventet'),
    p(
      'PDF-knappen skal downloade/åbne selve servitut-dokumentet. Eventuelle bilag bør være SEPARATE download-muligheder (fx en badge "3 bilag" der ved klik åbner bilags-liste med individuel download pr. bilag), ikke blive slået sammen med hoved-PDFen.'
    ),
    h(2, 'Sandsynlig årsag'),
    bullets([
      'Servitut-PDF-endpoint (fx /api/tinglysning/pdf?dok=XXX) kalder e-TL dokument-API der returnerer både hoveddokument + alle tilhørende bilag i samme respons',
      'Frontend loop\'er over ALLE returnerede elementer og åbner dem hver især — men filterer ikke på rolle=hoveddokument vs rolle=bilag',
      'Alternativt: tillægstekst-parsing opsnapper de 3 UUID\'er og åbner dem alle som "PDF" uden at adskille hoveddok fra bilag',
      'e-TL giver typisk dokument-metadata med type/rolle — fx "SERVITUT" vs "BILAG" — som skal respekteres i download-logikken',
    ]),
    h(2, 'Reproduktion'),
    bullets([
      'Login på test.bizzassist.dk',
      'Naviger til URL ovenfor (eller søg Thorvald Bindesbølls Plads 18 hovedejendom)',
      'Klik Tinglysning-tab',
      'Klik på PDF-knappen ved række 13 "DEKLARATION OM TILSLUTNINGS..."',
      'Observer at ~3 browser-faner åbner med bilag — men IKKE hoveddokumentet',
      'Alternativt test med række 12 (2 bilag), 16 (2 bilag), 17 (1 bilag) eller 19 (1 bilag) — samme adfærd',
    ]),
    h(2, 'Foreslået fix'),
    bullets([
      'Identificér hoveddokumentet i e-TL-svaret via dokumenttype/rolle-felt (ikke via index-position)',
      'PDF-knap på servitut-rækken skal KUN åbne hoveddokumentet (én PDF, ikke flere faner)',
      '"N bilag"-badge ved siden af titlen bør udvides til interaktiv drawer/modal der viser alle bilag med individuelle download-knapper',
      'Audit andre tab-typer (Dokumenter, Påtegninger) for samme fejl',
    ]),
    h(2, 'Acceptance criteria'),
    bullets([
      'PDF-knap på servitut-række downloader/åbner præcis ét dokument: selve servitutten',
      'Bilag tilgås via separat UI-element ("N bilag" badge eller drawer)',
      'Ingen uønskede browser-faner ved almindelig PDF-download',
      'Ingen regression på rækker uden bilag (skal fortsat virke som før)',
      'Testet på række 13 (3 bilag) + række uden bilag',
    ]),
    h(2, 'Relaterede tickets'),
    bullets([
      'Eventuelt BIZZ-## (tidligere tinglysning-fixes) — verificer at dette ikke er regression',
    ]),
  ],
};

const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary: 'Tinglysning: PDF-download åbner kun bilag — hoveddokument (servitut) mangler',
    description,
    issuetype: { name: 'Task' },
    priority: { name: 'High' },
    labels: ['tinglysning', 'pdf', 'download', 'servitut', 'ui'],
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
