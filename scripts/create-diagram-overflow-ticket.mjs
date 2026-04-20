#!/usr/bin/env node
/**
 * Creates a new JIRA bug ticket for the Novo Nordisk diagram overflow overlap
 * regression — BIZZ-558 was closed but the overlap is still observed.
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

// Discover Bug issue-type id
const meta = await req(
  'GET',
  `/rest/api/3/issue/createmeta?projectKeys=${PROJECT}&expand=projects.issuetypes`
);
const types = JSON.parse(meta.body).projects?.[0]?.issuetypes ?? [];
const bugType =
  types.find((t) => /^bug$/i.test(t.name)) ??
  types.find((t) => /^task$/i.test(t.name)) ??
  types.find((t) => /^story$/i.test(t.name)) ??
  types.find((t) => !t.subtask);
if (!bugType) {
  console.error(
    'No Bug/Task issue type found. Available:',
    types.map((t) => t.name)
  );
  process.exit(1);
}
console.log(`Using issue type: ${bugType.name}`);

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
        { type: 'text', text: 'På ', marks: [] },
        { type: 'text', text: 'Novo Nordisk-virksomhedsdiagrammet', marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: ' (test.bizzassist.dk/dashboard/companies/24256790 → Diagram-fanen) overlapper overflow-ejendomsboksen ("+74 ejendomme") stadig tilstødende noder i layoutet. BIZZ-558 markerede problemet som løst, men det er observeret igen (2026-04-19).',
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
                  text: 'Midt i diagrammet (under Novo Nordisk A/S-noden) ligger "+74 ejendomme"-boksen oven på / under Krogshøjvej 47-noden — de to bokse kolliderer visuelt så tekst er delvist skjult.',
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
                  text: 'Overflow-boksens ekspanderede indhold (adresselinjer) rendres i samme lag som de omkringliggende ejendoms-noder — ingen z-order eller reserveret plads.',
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
      content: [{ type: 'text', text: 'Hypotese' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'BIZZ-558 fiksede tekst-truncation inde i boksen, men løste ikke layout-kollisionen når boksen udvides. Diagram-layoutet (react-force-graph / custom SVG) reserverer ikke plads til overflow-ekspansionen, så ekspanderede bokse overlapper sibling-noder der er placeret i samme laterale slice.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Forslag til løsning' }],
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
                  text: 'Ekspandér overflow-boksen NEDAD (ikke i eksisterende slot) og push øvrige nederste noder ned tilsvarende.',
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
                  text: 'Alternativt: render overflow-indholdet som en modal/popover i stedet for inline ekspansion.',
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
                  text: 'Øg z-index og tilføj solid baggrund så boksen ikke er semi-transparent over sibling-nodes (workaround, ikke permanent fix).',
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
                  text: 'På Novo Nordisk-diagrammet overlapper "+N ejendomme"-boksen ikke nogen anden node, hverken sibling ejendomsnoder eller parent-/child-noder.',
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
                  text: 'Ekspansion af overflow-boksen ændrer ikke positionen af andre noder så de bliver usynlige eller kolliderer.',
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
                  text: 'Relaterer: BIZZ-558 (closed but regressed), BIZZ-479 (overflow ejendomsboks tekst).',
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
      'Diagram: overflow-ejendomsboks overlapper sibling-noder på Novo Nordisk-diagram (regression fra BIZZ-558)',
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
