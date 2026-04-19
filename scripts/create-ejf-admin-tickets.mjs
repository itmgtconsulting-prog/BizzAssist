#!/usr/bin/env node
/**
 * Creates two JIRA tickets derived from 2026-04-19 EJF access probe:
 *   (A) Feature — vis ejendomsadministrator på ejendomsside via de 2 nye
 *       bekræftede services (Ejendomsadministrator + PersonEllerVirksomhedsadmini).
 *   (B) Support — afklar korrekt GraphQL-field-navn for CustomPersonSimpelBegraenset
 *       med SDFI (8 navne-varianter probet uden succes).
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';
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

const meta = await req('GET', `/rest/api/3/issue/createmeta?projectKeys=${PROJECT}&expand=projects.issuetypes`);
const types = JSON.parse(meta.body).projects?.[0]?.issuetypes ?? [];
const taskType =
  types.find((t) => /^task$/i.test(t.name)) ??
  types.find((t) => /^bug$/i.test(t.name)) ??
  types.find((t) => !t.subtask);

// ──────────────── Ticket A: Administrator-feature ────────────────
const descA = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Baggrund' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Probe 2026-04-19 bekræftede at vi har adgang til 2 nye EJF GraphQL-services via flexibleCurrent/v1/ som vi ikke bruger i dag: ',
        },
        { type: 'text', text: 'EJFCustom_EjendomsadministratorBegraenset', marks: [{ type: 'code' }] },
        { type: 'text', text: ' og ' },
        { type: 'text', text: 'EJFCustom_PersonEllerVirksomhedsadminiBegraenset', marks: [{ type: 'code' }] },
        {
          type: 'text',
          text: '. Sammen kan de levere "hvem administrerer denne ejendom?"-data — særligt vigtigt for ejerforeninger, udlejningsejendomme og erhvervs­ejendomme hvor administratoren ofte er en anden virksomhed end ejeren.',
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Feature' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Tilføj en Administrator-sektion på ejendoms-detaljesiden (under "Ejerskab"-fanen eller som ny kort på Oversigt) der viser:',
        },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Administratorens navn (person eller virksomhed)' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Klikbart link til CVR-siden (hvis virksomhed) eller person-siden (hvis person)' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Rollens virkningsperiode (fra-til dato)' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Kontaktoplysninger hvis tilgængeligt via PersonEllerVirksomhedsadmini' }],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Teknisk' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Nyt endpoint: ' },
                { type: 'text', text: '/api/ejendomsadmin?bfeNummer=X', marks: [{ type: 'code' }] },
                { type: 'text', text: ' der forespørger EJFCustom_EjendomsadministratorBegraenset filtreret på BFE.' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Resolve administratorens ID via PersonEllerVirksomhedsadminiBegraenset for at få navn + type (person/virksomhed) + kontakt-felter.',
                },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Cache pr. BFE i 24 timer (samme TTL som øvrige EJF-data).',
                },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'UI: ny komponent EjendomAdministratorCard i app/components/ejendomme/',
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Bonus: reverse lookup' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'På virksomhedssiden kan vi tilføje en "Administrerede ejendomme"-fane for ejendomsadministrations-selskaber — find alle BFE\'er hvor virksomheden optræder som administrator. Det er et naturligt følge-feature når API\'et er wired op, men kan lægges i separat ticket.',
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Ejendom med administrator (fx ejerforening) viser administrator-sektion.' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Ejendom uden administrator viser ingen sektion (skjult, ikke "Ukendt").' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Klik på administrator fører til CVR- eller person-detaljeside.' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Relaterer: reference_datafordeler_ejf.md (memory), BIZZ-534 (EJF bulk — alternativ dataadgang), SDFI support 2026-04-19.',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ──────────────── Ticket B: SDFI support follow-up ────────────────
const descB = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Baggrund' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'SDFI-support bekræftede 2026-04-19 at vores abonnement dækker 4 Custom-tjenester på EJF GraphQL (flexibleCurrent/v1/):',
        },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'CustomEjerskabBegraenset — ✅ findes som EJFCustom_EjerskabBegraenset' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'CustomEjendomsadministratorBegraenset — ✅ findes som EJFCustom_EjendomsadministratorBegraenset' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'CustomPersonEllerVirksomhedsadminiBegraenset — ✅ findes som EJFCustom_PersonEllerVirksomhedsadminiBegraenset' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'CustomPersonSimpelBegraenset — ❌ kan IKKE findes under nogen gættet GraphQL-field-navn' }] }] },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Problem' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Vi har probet 8 GraphQL-field-navne for CustomPersonSimpelBegraenset uden succes. Alle returnerer "The field X does not exist on the type Query". Uden adgang til denne service kan vi ikke hente person-stamdata (navn + fødselsdato) via EJF — kritisk for person→ejendomme-lookup (BIZZ-534).',
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Probede navne' }] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'EJFCustom_PersonSimpelBegraenset' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'CustomPersonSimpelBegraenset' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'EJFCustom_SimpelPerson' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'EJFCustom_PersonSimpleBegraenset' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'EJFCustom_Person' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'EJFCustom_PersonBasisBegraenset' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'EJFCustom_PersonEjerskabBegraenset' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'EJFCustom_PersonSimpel' }] }] },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Rolle-identifier: ' },
        { type: 'text', text: 'DAF:ROLE:EJF:CustomPersonSimpelBegraenset', marks: [{ type: 'code' }] },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Opgaver' }] },
    {
      type: 'orderedList',
      attrs: { order: 1 },
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Send opfølgnings-mail til SDFI support med listen af probede navne.' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Spørg efter det korrekte GraphQL-field-navn for rollen DAF:ROLE:EJF:CustomPersonSimpelBegraenset.',
                },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Spørg også om det findes på et andet endpoint end flexibleCurrent/v1/ (fx flexibleHistory eller en REST-variant).',
                },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Opdater reference_datafordeler_ejf.md i memory så snart svar modtages, og verificer via /api/debug/ejf-probe.',
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Korrekt GraphQL-field-navn for CustomPersonSimpelBegraenset verificeret via probe (HTTP 200 + nodes returned).' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Memory opdateret med endeligt navn.' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Probe-endpointet /api/debug/ejf-probe fjernet eller parkeret (har tjent sit formål).' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ──────────────── Create both ────────────────
console.log('→ Creating ticket A (Administrator feature)…');
const resA = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    summary: 'Ejendom: vis administrator via ejfcustom_ejendomsadministratorbegraenset + personellervirksomhedsadmini',
    description: descA,
    issuetype: { id: taskType.id },
    priority: { name: 'Medium' },
  },
});
if (resA.status !== 201) {
  console.error('A failed:', resA.body.slice(0, 400));
  process.exit(1);
}
const keyA = JSON.parse(resA.body).key;
console.log(`  Created ${keyA}`);

console.log('→ Creating ticket B (SDFI support follow-up)…');
const resB = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    summary: 'EJF: afklar graphql-field-navn for custompersonsimpelbegraenset (sdfi support follow-up)',
    description: descB,
    issuetype: { id: taskType.id },
    priority: { name: 'Low' },
  },
});
if (resB.status !== 201) {
  console.error('B failed:', resB.body.slice(0, 400));
  process.exit(1);
}
const keyB = JSON.parse(resB.body).key;
console.log(`  Created ${keyB}`);

console.log(`\nDone.\n  ${keyA} — Admin feature\n  ${keyB} — SDFI support follow-up`);
