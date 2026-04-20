#!/usr/bin/env node
/**
 * Creates JIRA ticket: Søgning matcher ikke initial-forkortelser med/uden
 * punktummer ("HC" vs "H.C." vs "H C").
 *
 * Observeret 2026-04-20 på test.bizzassist.dk /dashboard/ejendomme:
 * "HC møllersvej 21" giver ingen resultater selvom ejendommen eksisterer
 * som "H C Møllersvej 21, Poulsker, 3730 Nexø" (BFE 5.157.134, Jakobs
 * personligt ejede ejendom).
 *
 * Run: node scripts/create-search-abbreviation-ticket.mjs
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
      'Rapporteret 2026-04-20 af bruger via screenshot fra test.bizzassist.dk. Adresse-søgningen på /dashboard/ejendomme matcher ikke forkortelser af fornavne med eller uden punktummer/mellemrum. Dette gør at almindelige staveformer som "HC Møllersvej" ikke returnerer den officielle DAWA-adresse "H C Møllersvej" eller "H.C. Møllersvej".'
    ),
    h(2, 'Observeret på'),
    bullets([
      'URL: https://test.bizzassist.dk/dashboard/ejendomme',
      'Aktiv sektion: Ejendomme (search-sub-header: "Søg på alle ~2,8 mio. danske adresser")',
      'Søgeinput: "H.C. Møllersvej 21"',
      'Resultat i screenshotet: "H C Møllersvej 21, Poulsker, 3730 Nexø" (1 match — denne variant virker)',
      'Rapporteret problem-variant: "HC møllersvej 21" (uden punktummer + uden mellemrum mellem H og C) → 0 resultater',
    ]),
    h(2, 'Faktisk ejendom (reference)'),
    bullets([
      'Adresse: H C Møllersvej 21, 3730 Nexø',
      'BFE: 5.157.134',
      'Ejer: Jakob Juul Rasmussen (100%, virkning fra 2020-07-03)',
      'Ligger i Jakobs 9 personligt ejede ejendomme (verificeret via ejf_ejerskab)',
    ]),
    h(2, 'Testede varianter'),
    code(
      `Input                          Forventet             Nuværende
───────────────────────────────────────────────────────────────
H.C. Møllersvej 21             findes                findes ✓
H C Møllersvej 21              findes                findes ✓  (DAWA-form)
HC Møllersvej 21               findes                IKKE findes ✗
HC møllersvej 21               findes (case-insens)  IKKE findes ✗
H.C.Møllersvej 21              findes (no space)     ukendt (test)
hc møllersvej 21               findes                ukendt (test)`
    ),
    h(2, 'Sandsynlig årsag'),
    bullets([
      'DAWA /autocomplete bruger sandsynligvis whitespace-tokenisering uden initial-normalisering. "HC" tokeniseres som ét ord mens "H C" er to tokens → match på forskellige strings',
      'Alternativt: vores search-rute (app/api/ejendomme/search eller tilsvarende) sender rå bruger-input til DAWA uden normalisering',
      'DAWA har formodentlig variant-index, men vores query matcher ikke de forventede varianter',
      'Samme bug rammer sandsynligvis andre initial-adresser: "J.B. Winsløws Vej", "A.P. Møllers Boulevard", "F.F. Ulriks Gade", "H.P. Hansens Plads" osv.',
    ]),
    h(2, 'Reproduktion'),
    bullets([
      'Login på test.bizzassist.dk',
      'Klik Ejendomme i venstre nav',
      'Indtast "HC Møllersvej 21" (uden punktummer, uden mellemrum)',
      'Observer: ingen resultater trods at adressen eksisterer',
      'Test kontrast: indtast "H C Møllersvej 21" (med mellemrum) → finder adressen',
    ]),
    h(2, 'Foreslået fix'),
    bullets([
      'I søgerute (app/api/ejendomme/search eller /api/adresse/autocomplete): pre-normaliser input før DAWA-kald',
      'Normaliserings-regler: lowercase + indsæt mellemrum efter hver punctuation + collapse whitespace + expand kendte forkortelses-mønstre',
      'Specifikt for initial-par: detect pattern /\\b([A-ZÆØÅ])\\.?\\s*([A-ZÆØÅ])\\.?\\b/ og producer varianter "HC", "H C", "H.C.", "H. C."',
      'Eller: send begge varianter til DAWA som fuzzy-match parallel-queries og flet resultaterne',
      'Test med autocomplete + fuld-search endpoints',
    ]),
    h(2, 'Acceptance criteria'),
    bullets([
      'Søgning på "HC Møllersvej 21" returnerer samme resultat som "H C Møllersvej 21"',
      'Søgning på "H.C.Møllersvej 21" (ingen mellemrum) returnerer samme resultat',
      'Case-insensitive: "hc møllersvej 21" virker',
      'Fungerer tilsvarende for andre initial-par (fx "A P Møllers", "J B Winsløws", "F F Ulriks")',
      'Ingen regression på alle andre søgninger (adresser uden initialer matcher som før)',
      'Autocomplete-dropdown + fuld-søgning matcher ens',
    ]),
    h(2, 'Relaterede tickets'),
    bullets([
      'rensAdresseStreng (app/lib/dawa.ts / dar.ts) — eksisterende normaliserings-helper',
      'BIZZ-597 — person/virksomhed alignment (søgnings-API er fælles)',
    ]),
  ],
};

const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary:
      'Søgning: initial-forkortelser uden mellemrum/punktum matcher ikke ("HC" vs "H C" vs "H.C.")',
    description,
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    labels: ['søgning', 'dawa', 'adresse', 'normalization', 'ux'],
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
