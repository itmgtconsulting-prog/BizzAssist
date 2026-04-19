#!/usr/bin/env node
/**
 * Creates a JIRA ticket: only show direct shareholders (andelshavere) on
 * ownership diagram — not reelle ejere (ultimate beneficial owners).
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
const bugType =
  types.find((t) => /^task$/i.test(t.name)) ??
  types.find((t) => /^bug$/i.test(t.name)) ??
  types.find((t) => !t.subtask);

const description = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Problem' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Ejerskabsdiagrammet for JAJR Ejendomme ApS viser en ekstra ejer-linje fra Jakob Juul Rasmussen der springer to niveauer over — han er tegnet som direkte ejer-relation til JaJR Holding 2 ApS selvom han kun er ',
        },
        { type: 'text', text: 'reel ejer (UBO)', marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: ' via sit ejerskab af JaJR Holding ApS. Det giver et forvirrende diagram hvor andelshavere og reelle ejere blandes.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Reproduktion' }],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'URL: test.bizzassist.dk/dashboard/companies/26316804' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Virksomhed: JAJR Ejendomme ApS (CVR 26316804)' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tab: Diagram' }] }],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Observeret' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Korrekt andels-kæde i diagrammet:' }],
    },
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
                { type: 'text', text: 'JAJR Ejendomme ApS ← JaJR Holding 2 ApS (90-100%)' },
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
                  text: 'JaJR Holding 2 ApS ← 4 holdingselskaber (~25% hver): JaJR Holding, DJKL Holding, SJKL Holding, FJKL Holding',
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
                  text: 'Hver af de 4 holdingselskaber ← én person (Jakob/David/Silas/Felix) med 90-100%',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Men der tegnes desuden en ', marks: [] },
        { type: 'text', text: 'ekstra linje direkte fra Jakob Juul Rasmussen', marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: ' (på niveau med David/Silas/Felix) ned til JaJR Holding 2 ApS eller JAJR Ejendomme ApS — reel ejer-kanten, ikke en andels-kant.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Ønsket adfærd' }],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Diagrammet skal UDELUKKENDE vise andelshavere (direkte ejere med tinglyst/registreret kapitalandel via deltagerRelation).',
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
                { type: 'text', text: 'Reelle ejere (UBO) skal IKKE tegnes som en ekstra kant', marks: [{ type: 'strong' }] },
                {
                  type: 'text',
                  text: ' — de udledes allerede implicit ved at følge andels-kanterne op til top-personen.',
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
                  text: 'Jakob skal derfor kun fremgå som direkte ejer af JaJR Holding ApS (ikke som parent til JaJR Holding 2 eller JAJR Ejendomme).',
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
                  text: 'Hvis UBO-info ønskes på et senere tidspunkt, skal det være via separat toggle eller badge på den relevante person-node — ikke som kanter der visuelt ligner andelsrelationer.',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Teknisk årsag (hypotese)' }],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Data-kilden for diagrammet flette nok CVR deltagerRelation (andelshavere) med reelleEjere-rollen fra samme deltager-array — reelleEjere-rollen skal filtreres fra inden kant-tegning.',
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
                  text: 'Filter: kun relationer hvor rolle ∈ {EJER/EJERREGISTER med kapitalandel} skal tegnes som ejerskabskanter. Roller som REEL_EJER, UBO, LEGAL_OWNER skal ignoreres i diagram-rendering.',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Acceptance criteria' }],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'På JAJR Ejendomme ApS-diagrammet har Jakob Juul Rasmussen KUN én udgående ejerskabs-kant — til JaJR Holding ApS.',
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
                  text: 'Andels-kæden vises rent: Jakob → JaJR Holding ApS → JaJR Holding 2 ApS → JAJR Ejendomme ApS. Ingen "spring over niveau"-kanter.',
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
                  text: 'Testes på 3 virksomheder med forskellig ejerstruktur: JAJR Ejendomme ApS (personer+holdings), Novo Nordisk A/S (fonde+institutionelle), JaJR Holding 2 ApS (4-parts split).',
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
                  text: 'Relaterer: BIZZ-564 (JAJR Ejendomme 2 ejerkæde — samme type problem), BIZZ-471 (ophørte virksomheder som reelle ejere).',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const payload = {
  fields: {
    project: { key: PROJECT },
    summary: 'Diagram: vis kun andelshavere — filtrér reelle ejere (UBO) fra ejerskabs-kanter',
    description,
    issuetype: { id: bugType.id },
    priority: { name: 'Medium' },
  },
};

const res = await req('POST', '/rest/api/3/issue', payload);
if (res.status === 201) {
  const key = JSON.parse(res.body).key;
  console.log(`Created: ${key}`);
  console.log(`URL: https://${HOST}/browse/${key}`);
} else {
  console.log(`FAILED (${res.status}):`, res.body.slice(0, 500));
}
