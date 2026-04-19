#!/usr/bin/env node
/**
 * Creates JIRA ticket for EJF PV-oplys (Parter Uden CVR/CPR) ingestion.
 *
 * Context: BIZZ-534 bulk-ingestion fanger kun ejere med CPR (person) eller CVR
 * (virksomhed). EJF har en tredje type — PV-oplys — som dækker dødsboer, fonde,
 * udenlandske ejere, ejerforeninger og kommunale enheder. Disse udgør ~10-15%
 * af alle EJF-ejerskaber og skipper vi p.t. i ingestion (tælles som "failed").
 *
 * Dette er en opfølgnings-ticket til BIZZ-534 og skal sættes On Hold/Blocked
 * da det ikke er kritisk for person→ejendomme-featuren.
 *
 * Run: node scripts/create-pv-oplys-ticket.mjs
 */

import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

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

// ─── ADF document builders ────────────────────────────────────────────────
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
const code = (text, lang = 'sql') => ({
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
      'BIZZ-534 bulk-ingestion mapper EJF-ejerskaber til ejf_ejerskab-tabellen via to ejer-typer: ',
      { type: 'text', text: 'person', marks: [{ type: 'strong' }] },
      ' (CPR-baseret, har ejendePersonBegraenset.id) og ',
      { type: 'text', text: 'virksomhed', marks: [{ type: 'strong' }] },
      ' (CVR-baseret, har ejendeVirksomhedCVRNr...CVRNummer).'
    ),
    p(
      'EJF har dog en tredje ejer-kategori — ',
      { type: 'text', text: 'PV-oplys (Parter Uden CVR/CPR)', marks: [{ type: 'strong' }] },
      ' — som dækker ejerskaber der hverken har dansk CPR eller CVR. Disse skippes i dag i mapNodeToRow og tælles som "failed" i cron-statistikken.'
    ),
    h(3, 'Hvilke ejere er PV-oplys?'),
    bullets([
      'Dødsboer — ejendom ejet af afdød person indtil skiftets afslutning',
      'Fonde og stiftelser — fx Realdania, A.P. Møller Fonden (EJF kobler dem ikke via CVRNummer)',
      'Udenlandske selskaber/personer — ejere uden dansk CVR/CPR',
      'Ejerforeninger — fælles arealer i andelsforeninger',
      'Kommunale enheder, menighedsråd — særlige identifier-typer',
    ]),
    h(3, 'Datavolumen'),
    p('Observation fra BIZZ-534 ingestion (preview-miljø, april 2026): ~10-15% af alle EJF-records er PV-oplys. Med ~6M records totalt svarer det til ~600-900k ejerskaber vi ikke fanger.'),
    h(2, 'Opgave'),
    h(3, '1. Schema-udvidelse'),
    p('Tilføj nye kolonner til public.ejf_ejerskab for PV-oplys-specifikke felter:'),
    code(
      `alter table public.ejf_ejerskab
  add column fiktivt_pv_nummer text,
  add column landekode text,
  add column udlandsadresse text,
  add column administrator text;

-- Udvid ejer_type check-constraint
alter table public.ejf_ejerskab
  drop constraint ejf_ejerskab_ejer_type_check;
alter table public.ejf_ejerskab
  add constraint ejf_ejerskab_ejer_type_check
    check (ejer_type in ('person', 'virksomhed', 'pvoplys'));`
    ),
    h(3, '2. Udvidet GraphQL query'),
    p(
      'Nuværende query i /api/cron/ingest-ejf-bulk bruger kun ejendePersonBegraenset + ejendeVirksomhedCVRNr-felter. Tilføj EJF_PersonVirksomhedsoplys-feltsæt:'
    ),
    bullets([
      'ejendePartUdenCVRCPR { id fiktivtPVnummer landekode adresselinje1-10 administrator }',
      'Map PV-oplys-ejere med ejer_type=\'pvoplys\' og ejf_id=fiktivtPVnummer',
      'Persistér adresselinjer samlet som udlandsadresse-streng',
    ]),
    h(3, '3. Query-route til PV-ejere'),
    p(
      'Ny rute /api/ejerskab/pvoplys-properties?pvnr=X giver lookup af ejendomme for en PV-ejer. Bruges til fremtidig PV-detaljeside (afhænger af BIZZ-483).'
    ),
    h(3, '4. Diagram-integration'),
    p(
      'PV-ejer-noder i diagram (dødsbo / udenlandsk ejer / fond) skal have samme "Udvid"-funktionalitet som personer — klik hente deres øvrige ejendomme via pvoplys-properties.'
    ),
    h(2, 'Afhængigheder'),
    bullets([
      'BIZZ-534 skal være merged og seed-komplet før PV-oplys-data kan tilføjes',
      'BIZZ-483 (PV-detaljeside) er blokeret på lignende datamodelspørgsmål — evt. samling',
      'EJF_PersonVirksomhedsoplys-query kræver test mod Datafordeler (feltnavne kan variere)',
    ]),
    h(2, 'Acceptance criteria'),
    bullets([
      'Cron-ingestion rapporterer 0 fejl for PV-oplys (nuværende ~10-15% bliver ingested)',
      'Dødsboer, fonde og udenlandske ejere kan slås op via bfe-nummer',
      'Diagram viser "Udvid" på PV-ejer-noder med deres øvrige ejendomme',
      'Schema-migration er dokumenteret og reversibel',
    ]),
    h(2, 'Prioritet'),
    p(
      'Medium — ikke kritisk for person→ejendomme-feature (BIZZ-534) som kun kræver person-data. Kan tages op når behovet opstår (typisk når advokater/rådgivere spørger om dødsbo-ejendomme).'
    ),
    h(2, 'Referencer'),
    bullets([
      'BIZZ-534 — forudsætning (person/virksomhed bulk-ingestion)',
      'BIZZ-482 — oprindelig PV-oplys-query-udvidelse for ejerskabsliste',
      'BIZZ-483 — PV-detaljeside (blokeret, kan samles med denne)',
      'app/api/cron/ingest-ejf-bulk/route.ts mapNodeToRow — hvor skip-logikken ligger',
    ]),
  ],
};

// ─── Create ticket ────────────────────────────────────────────────────────
const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary: 'EJF PV-oplys bulk-ingestion — dødsboer, fonde, udenlandske ejere',
    description,
    issuetype: { name: 'Story' },
    priority: { name: 'Medium' },
    labels: ['ejf', 'bulk-ingestion', 'pv-oplys', 'opfølgning-bizz534'],
  },
};

const created = await req('POST', '/rest/api/3/issue', payload);
if (created.status !== 201) {
  console.error('Create failed:', created.status, created.body);
  process.exit(1);
}
const key = JSON.parse(created.body).key;
console.log(`Created: ${key}`);

// ─── Transition to Blocked / On Hold ──────────────────────────────────────
const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
const transitions = JSON.parse(tr.body).transitions || [];
console.log('Available transitions:', transitions.map((t) => t.name).join(', '));

const hold = transitions.find(
  (t) => /blocked|on hold|hold/i.test(t.name) || /blocked|on hold|hold/i.test(t.to?.name || '')
);

if (!hold) {
  console.log('No Blocked/On Hold transition available — leaving in default status');
} else {
  const res = await req('POST', `/rest/api/3/issue/${key}/transitions`, {
    transition: { id: hold.id },
  });
  console.log(`Transitioned to ${hold.name}: HTTP ${res.status}`);

  // Add comment explaining why it's on hold
  const commentBody = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '⏸ On hold: ', marks: [{ type: 'strong' }] },
            {
              type: 'text',
              text: 'Opfølgnings-ticket til BIZZ-534. PV-oplys (dødsboer, fonde, udenlandske ejere) er ikke kritisk for person→ejendomme-feature. Tages op når (a) BIZZ-534 er seed-komplet og (b) behovet opstår fra advokat/rådgiver-brugere.',
            },
          ],
        },
      ],
    },
  };
  await req('POST', `/rest/api/3/issue/${key}/comment`, commentBody);
  console.log('Added on-hold comment');
}

console.log(`\nDone: https://${HOST}/browse/${key}`);
