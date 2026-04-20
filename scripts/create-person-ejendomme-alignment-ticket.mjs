#!/usr/bin/env node
/**
 * Creates JIRA ticket for data + functional alignment between person and
 * company Ejendomme-tabs.
 *
 * Rapporteret 2026-04-20 af bruger: ejendomsbokse på personens Ejendomme-tab
 * matcher ikke virksomhedens Ejendomme-tab i hverken datafelter eller
 * funktionalitet (filtre, sortering, progressive enrichment m.m.).
 *
 * Run: node scripts/create-person-ejendomme-alignment-ticket.mjs
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
      'Rapporteret 2026-04-20 af bruger: Ejendoms-bokse på personers Ejendomme-tab er ikke alignet med tilsvarende bokse på virksomhedernes Ejendomme-tab — hverken data-mæssigt eller funktionsmæssigt.'
    ),
    p(
      'Målet er paritet: samme datafelter, samme layout, samme interaktioner så brugeren får konsistent oplevelse uanset om de kigger på en person eller virksomhed.'
    ),
    h(2, 'Data-mæssig alignment'),
    h(3, 'Virksomheds-tabben har (reference)'),
    bullets([
      'Adresse (vejnavn, husnr, etage, dør)',
      'Postnr + by',
      'BFE-nummer',
      'Ejendomstype (fx Ejerbolig, Erhvervsejendom)',
      'Ejerandel (brøk + procent)',
      'Status (aktiv / solgt + solgtDato)',
      'Progressive enrichment: areal, vurdering, vurderingsår, købesum, købsdato (BIZZ-397)',
      'Ejer-navn (for virksomhed = CVR-navn med fallback)',
      'Link til ejendoms-detaljeside via dawaId',
    ]),
    h(3, 'Person-tabben skal have samme'),
    p('Alle felter ovenfor + specifikt for personligt ejede:'),
    bullets([
      'Medejer-visning (fx "50% Jakob + 50% Kamilla") når ejerandel < 100%',
      'Virkning_fra (dato hvor ejerskab trådte i kraft — relevant for personer)',
      'Badge for "Personligt ejet" vs "Via virksomhed" så kilden er synlig',
    ]),
    h(2, 'Funktions-mæssig alignment'),
    h(3, 'Virksomheds-tabben har (reference)'),
    bullets([
      'Sortering: aktive først, derefter solgte',
      'Klik på boks → navigerer til ejendoms-detaljeside',
      'Fold ud for detaljer (hvis relevant)',
      'Progressive loading (batch-wise fra API, BIZZ-397)',
      'Infinite scroll / offset-paginering',
      'Tom-state besked ved 0 ejendomme',
      '"Vis historik"-toggle til at inkludere solgte (BIZZ-569)',
      'Horisontal grid-layout på desktop, stack på mobil',
    ]),
    h(3, 'Person-tabben skal have samme'),
    p('Identisk adfærd og layout. Ingen særlig "person-only" UX — konsistens er målet.'),
    h(2, 'Opgave'),
    bullets([
      'Refactor Person-Ejendomme komponent til at genbruge VirksomhedEjendomme-komponent som delt subcomponent (evt. factor ud til app/components/EjendommeListe.tsx)',
      'Shared props-interface der accepterer både CVR- og enhedsNummer-baseret input',
      'Data-kilde: ejendomme-by-owner (cvrs) + ejerskab/person-properties + bfe-addresses (samme som diagram-integration fra BIZZ-594/595)',
      'Visuel design: match virksomheds-variantens horisontal grid og kort-styling',
      'Interaktioner: identiske hover, klik, fold-ud, filter-knapper',
    ]),
    h(2, 'Acceptance criteria'),
    bullets([
      'Ejendomme-boks på personers side har samme felter synlige som på virksomhedsside',
      'Samme sortering og filter-adfærd',
      'Progressive enrichment virker på begge (areal/vurdering tilføjes asynkront)',
      'Side-by-side visuel sammenligning viser ingen forskelle ud over "Personligt ejet"-badge',
      'Ingen regression på virksomheds-fanen',
    ]),
    h(2, 'Relaterede tickets'),
    bullets([
      'BIZZ-595 — personligt ejede ejendomme mangler på person-tab (forudsætning)',
      'BIZZ-580 — oprindelig person/virksomhed layout alignment',
      'BIZZ-569 — virksomheds horisontal grid + udvidede datafelter (reference-impl)',
      'BIZZ-397 — progressive enrichment pattern',
    ]),
  ],
};

const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary: 'Person → Ejendomme: align datafelter + funktionalitet med virksomhedsfanen',
    description,
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    labels: ['person', 'ejendomme', 'alignment', 'ui', 'refactor'],
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
