#!/usr/bin/env node
/**
 * Creates a JIRA ticket: add hæftelse-amount and standard property data
 * (salgspris, vurdering, bolig/erhverv/matrikel m²) to creditor-ejendomme
 * list on company Tinglysning tab.
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

const meta = await req(
  'GET',
  `/rest/api/3/issue/createmeta?projectKeys=${PROJECT}&expand=projects.issuetypes`
);
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
          text: 'På Virksomhed → Tinglysning → Ejendomme-sektionen (ejendomme hvor virksomheden er kreditor via tinglyst hæftelse/ejerpantebrev) vises ejendommen men ikke hæftelsens størrelse — så brugeren kan ikke overskue virksomhedens samlede tinglyste tilgodehavender. Desuden mangler de standard property-datafelter vi i øvrigt viser på ejendomslister.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Ønsket ændring' }],
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
                {
                  type: 'text',
                  text: 'Vis hæftelsens beløb ',
                  marks: [],
                },
                {
                  type: 'text',
                  text: 'fremhævet på hvert ejendomskort',
                  marks: [{ type: 'strong' }],
                },
                {
                  type: 'text',
                  text: ' — fx "Hæftelse: 9.927.000 DKK" + type (Ejerpantebrev / Realkreditpantebrev etc.) + tinglysningsdato.',
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
                  text: 'Tilføj de samme datafelter under BFE-nummeret som på Ejendomme-tabben (jf. BIZZ-569):',
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
                      content: [
                        { type: 'text', text: 'Salgspris (🛒) — seneste tinglyste handel' },
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
                          text: 'Seneste foreløbige vurdering (📈) — gul tekst + år',
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
                      content: [{ type: 'text', text: 'Bolig m² (🏠)' }],
                    },
                  ],
                },
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Erhverv m² (🏢)' }],
                    },
                  ],
                },
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Matrikel m² (📐)' }],
                    },
                  ],
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
                  text: 'Tilføj samlet øverst: "Samlet hæftelse: X DKK fordelt på Y ejendomme" — giver øjeblikkelig totaloversigt over virksomhedens tinglyste tilgodehavender.',
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
      content: [{ type: 'text', text: 'Reproduktion / kontekst' }],
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
                  text: 'Referenceeksempel: Bibliotekvej 58 har et ejerpantebrev på 9.927.000 DKK med JAJR Ejendomme 2 ApS som kreditor (7. nov. 2025). På virksomhedssiden for JAJR Ejendomme 2 ApS → Tinglysning → Ejendomme bør denne hæftelse vises.',
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
                  text: 'Ejendomskort-komponenten (PropertyOwnerCard) skal udvides eller få en variant der inkluderer hæftelse-data + de udvidede felter.',
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
                  text: 'På Virksomhed → Tinglysning → Ejendomme viser hvert kort: hæftelsens beløb + type + dato.',
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
                  text: 'Under BFE-nummer vises salgspris, vurdering (gul+år), bolig/erhverv/matrikel m² — samme pattern som BIZZ-569.',
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
                  text: 'Øverst på sektionen vises total hæftelse + antal ejendomme.',
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
                  text: 'Layout matcher BIZZ-569 grid (3-4 kolonner desktop, responsive).',
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
                  text: 'Relaterer: BIZZ-569 (ejendomme-layout), BIZZ-556 (ejendomskort-labels).',
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
    summary:
      'Virksomhed → Tinglysning → Ejendomme: vis hæftelse-beløb + udvidede property-datafelter',
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
