#!/usr/bin/env node
/**
 * Creates a JIRA ticket for deduplicating servitutter fetched from both
 * ejerlejlighed and hovedejendom.
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
          text: 'For ejerlejligheder henter vi servitutter både fra lejligheden selv og fra den tilhørende hovedejendom (for at sikre at rettigheder tinglyst på bygningen som helhed vises). Men vi deduplikerer ikke — servitutter der tinglyst både på hovedejendom og ejerlejlighed vises to gange i listen, og gør det svært for brugeren at overskue hvilke byrder der reelt gælder.',
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
                { type: 'text', text: 'Ejendom: ' },
                {
                  type: 'text',
                  text: 'Thorvald Bindesbølls Plads 18, 3. th, 1799 København V',
                  marks: [{ type: 'strong' }],
                },
                { type: 'text', text: ' (BFE 100165718)' },
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
                  text: 'URL: test.bizzassist.dk/dashboard/ejendomme/dd4a90de-b126-4438-824f-3677efab2bd0',
                },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tab: Tinglysning' }] }],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Observeret' }],
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
                  text: 'Sektionen "SERVITUTTER (46)" har et badge "23 fra hovedejendom →" — dvs. halvdelen af rækkerne er hentet fra hovedejendommens tinglysning.',
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
                  text: 'Flere servitutter vises to gange med samme dato og tilnærmelsesvis samme beskrivelse — fx "Servitut 14. apr. 1939" står i både lejligheds- og hovedejendomslisten, og "Deklaration om tilslutnings- samt aftagepligt til fjernkøling" optræder flere gange.',
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
                  text: "Ingen indikator i UI'en fortæller brugeren at en given række er en duplikat af en anden.",
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
      content: [{ type: 'text', text: 'Ønsket adfærd' }],
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
                  text: 'Når vi flette servitutter fra ejerlejlighed + hovedejendom, dedupliker baseret på stabil nøgle — typisk e-TL dokument-UUID (samme dokument tinglyst på begge kan kun figurere én gang).',
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
                  text: 'Når dublet findes: fjern hovedejendommens version, behold ejerlejlighedens (ejerlejlighedens er mere specifik — tinglyst lokalt på netop den lejlighed).',
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
                  text: 'Hvis dokument-UUID ikke er tilgængelig som nøgle, fallback: (dato + servitut-titel + beløb) som composite key.',
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
                  text: 'Opdater badge-tælleren "N fra hovedejendom" så den viser det reelle antal UNIKKE hovedejendoms-servitutter efter dedup.',
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
                  text: 'Thorvald Bindesbølls Plads 18, 3. th viser ingen dubletter i servitut-listen — hvert dokument optræder præcis én gang.',
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
                  text: 'Ved dublet beholdes ejerlejlighed-versionen; hovedejendom-versionen filtreres fra.',
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
                  text: 'Servitutter der KUN findes på hovedejendom (ikke tinglyst specifikt på lejligheden) vises stadig — dedup må ikke skjule data.',
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
                  text: 'Badge "N fra hovedejendom" matcher faktisk antal hovedejendoms-unikke rækker efter dedup.',
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
                  text: 'Relaterer: BIZZ-472 (servitutter fra hovedejendom vises også på ejerlejlighed), BIZZ-474 (servitutter på hovedejendom), BIZZ-553 (servitut-overlap ejerlejlighed/hovedejendom).',
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
    summary: 'Tinglysning: dedupliker servitutter mellem ejerlejlighed og hovedejendom',
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
