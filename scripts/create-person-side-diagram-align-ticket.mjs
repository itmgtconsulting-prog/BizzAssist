#!/usr/bin/env node
/**
 * Creates JIRA ticket: person-noden på personsiden skal kunne foldes ud
 * og vise personligt ejede virksomheder + ejendomme. Funktionaliteten
 * skal være 1:1 med virksomhedsside-diagrammet.
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
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Problem' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'På person-side diagram (fx /dashboard/owners/4000115446 for Jakob Juul Rasmussen) er person-noden statisk — den kan ikke foldes ud. Det står i kontrast til virksomhedsside-diagrammet hvor ejer-noder kan udvides til at vise yderligere relationer. Resultat: personligt ejede virksomheder og ejendomme vises ikke uden at navigere væk fra diagrammet.',
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Reproduktion' }] },
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
                  text: 'URL: test.bizzassist.dk/dashboard/owners/4000115446 → Diagram',
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
                  text: 'Jakob Juul Rasmussen-noden står øverst uden mulighed for at vise hans personligt ejede virksomheder eller ejendomme direkte (fx Thorvald Bindesbølls Plads 18, J.C. Jacobsens Gade 11, Hovager 8 m.fl. der ER synlige på virksomhedsdiagrammet).',
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Ønsket adfærd' }] },
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
                  text: 'Person-noden skal kunne foldes ud via klik (eller "+ Udvid N"-knap på selve noden, som virksomheds-noder har).',
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
                  text: 'Ved udvidelse: vis personligt ejede virksomheder + personligt ejede ejendomme direkte under personen — samme kort-format som på virksomhedssiden.',
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
                  text: 'Alle toolbar-funktioner skal være 1:1 med virksomhedsdiagrammet:',
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
                        { type: 'text', text: 'Zoom +/- / slider (samme trin, samme default)' },
                      ],
                    },
                  ],
                },
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Centrér-knap (centrerer om root-noden)' }],
                    },
                  ],
                },
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reset-knap' }] }],
                },
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        {
                          type: 'text',
                          text: 'Udvid / Skjul-toggle — inkl. rekursiv udvidelse af person-noden',
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
                          text: 'Ejendomme-toggle (default off på person-side, jf. BIZZ-571)',
                        },
                      ],
                    },
                  ],
                },
                {
                  type: 'listItem',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'Fullscreen-knap' }] },
                  ],
                },
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Pan/træk (mouse+touch) — samme interaktionsmodel' },
                      ],
                    },
                  ],
                },
                {
                  type: 'listItem',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'Dobbeltklik-zoom' }] },
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
                          text: 'Overflow-bokse (+N ejendomme) med udvidelse + bottom-row-placering (jf. BIZZ-568)',
                        },
                      ],
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
                  text: 'Node-styling: person-noder får samme styling som på virksomhedssiden; ejendomme/virksomheder får samme farvekoder og badges.',
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Teknisk tilgang' }] },
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
                  text: 'Refactor til fælles DiagramRenderer-komponent (jf. BIZZ-571, BIZZ-582) der håndterer udvidelse ens for person- og virksomhedsrodnoder. Kun data-kilden afhænger af entitets-typen.',
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
                  text: 'Data-fetch: CVR deltagerRelation (for personligt ejede virksomheder via personens enhedsNummer) + EJF EJFCustom_EjerskabBegraenset med ejendePersonBegraenset-filter (for personligt ejede ejendomme).',
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
                  text: 'Klik på Jakob Juul Rasmussen-noden (eller Udvid-knap) folder den ud og viser personligt ejede virksomheder + ejendomme.',
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
                  text: 'Toolbar-knapperne har identisk adfærd med virksomhedsdiagrammet — verificeret ved at side-by-side klikke på begge diagramtyper.',
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
                  text: 'Overflow-bokse placeres og udvides identisk på begge diagrammer (jf. BIZZ-568).',
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
              content: [{ type: 'text', text: 'Zoom, pan og centrér opfører sig ens.' }],
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
                  text: 'Relaterer: BIZZ-571 (person-diagram align), BIZZ-582 (udvid-knap + fuld alignment), BIZZ-585 (personligt ejede ejendomme på separat linje), BIZZ-581 (BFE-bokse format), BIZZ-568 (overflow bottom-row).',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const res = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    summary:
      'Person-diagram: person-node skal kunne foldes ud + fuld alignment med virksomhedsdiagram',
    description,
    issuetype: { id: bugType.id },
    priority: { name: 'Medium' },
  },
});
if (res.status === 201) {
  const key = JSON.parse(res.body).key;
  console.log(`Created: ${key}`);
  console.log(`URL: https://${HOST}/browse/${key}`);
} else {
  console.log(`FAILED (${res.status}):`, res.body.slice(0, 500));
}
