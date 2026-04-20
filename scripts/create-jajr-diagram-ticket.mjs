#!/usr/bin/env node
/**
 * Creates a JIRA ticket for the JAJR Ejendomme 2 diagram showing incomplete
 * ownership chain — 3 of 4 expected parent holding companies are missing.
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
  types.find((t) => /^bug$/i.test(t.name)) ??
  types.find((t) => /^task$/i.test(t.name)) ??
  types.find((t) => !t.subtask);
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
        {
          type: 'text',
          text: 'Ejerskabsdiagrammet på ejendomssiden viser en ufuldstændig og forkert ejerstruktur for ',
        },
        {
          type: 'text',
          text: 'JAJR Ejendomme 2 ApS (CVR 40432426)',
          marks: [{ type: 'strong' }],
        },
        {
          type: 'text',
          text: ' — kun 1 af 4 forventede moder-holdingselskaber vises, og ejerandelene summer til 200% i stedet for 100%.',
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
                {
                  type: 'text',
                  text: 'URL: test.bizzassist.dk/dashboard/ejendomme/0a3f507c-b879-32b8-e044-0003ba298018',
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
                { type: 'text', text: 'Ejendom: Bibliotekvej 58, 2650 Hvidovre (BFE 2091186)' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tab: Ejerskab' }] }],
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
      content: [{ type: 'text', text: 'Diagrammet viser (læst nedefra og op):' }],
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
                  text: 'Bibliotekvej 58 ← JAJR Ejendomme 2 ApS (100%) ✓',
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
                  text: 'JAJR Ejendomme 2 ApS har TO parents tegnet: JaJR Holding ApS (100%) OG JaJR Holding 2 ApS (100%) — andelene summer til 200%, hvilket er umuligt.',
                  marks: [{ type: 'strong' }],
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
                  text: "Ovenover står Jakob Juul Rasmussen som direkte parent — mellemleddet (JaJR Holding ApS → Jakob) er tegnet, men JaJR Holding 2's øvrige ejere mangler.",
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
      content: [{ type: 'text', text: 'Forventet' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Korrekt ejerkæde:' }],
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
                { type: 'text', text: 'Bibliotekvej 58 ejet af ' },
                { type: 'text', text: 'JAJR Ejendomme 2 ApS', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' (100%)' },
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
                { type: 'text', text: 'JAJR Ejendomme 2 ApS ejet af ' },
                { type: 'text', text: 'JAJR Holding 2 ApS', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' (100%) — ikke samtidig af JAJR Holding ApS' },
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
                { type: 'text', text: 'JAJR Holding 2 ApS ejet af ' },
                { type: 'text', text: '4 holdingselskaber', marks: [{ type: 'strong' }] },
                {
                  type: 'text',
                  text: ' — ét af dem er JAJR Holding ApS. De 3 øvrige holdingselskaber mangler helt i diagrammet.',
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
              content: [{ type: 'text', text: 'JAJR Holding ApS ejet af Jakob Juul Rasmussen' }],
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
                  text: "Ejerskabsgraf-bygningen folder to niveauer sammen (springer JAJR Holding 2 over) eller trækker JAJR Holding 2's parents fra forkert niveau.",
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
                  text: 'Reverse-lookup på deltagerRelation for JAJR Holding 2 ApS henter kun første ejer (JAJR Holding ApS) og stopper — tre øvrige ejere filtreres fra eller hentes aldrig.',
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
                  text: 'Ejerandels-normalisering er brudt: UI viser 100% på både JAJR Holding ApS OG JAJR Holding 2 ApS som parents af JAJR Ejendomme 2 — bør være én enkelt parent med 100%.',
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
                  text: 'JAJR Ejendomme 2 ApS har præcis én parent i diagrammet (JAJR Holding 2 ApS 100%).',
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
                  text: 'JAJR Holding 2 ApS viser alle 4 parent-holdingselskaber med korrekte ejerandele der summer til ≤100%.',
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
                  text: 'Jakob Juul Rasmussen står som slutligt real ejer bag JAJR Holding ApS — ikke som direkte ejer af JAJR Ejendomme 2.',
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
                  text: 'CVR-numrene i diagrammet matcher det faktiske CVR-data (verificér via datacvr.virk.dk).',
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
      'Ejerskabsdiagram: JAJR Ejendomme 2 viser forkert ejerkæde — 3 holdingselskaber mangler + 200% summering',
    description,
    issuetype: { id: bugType.id },
    priority: { name: 'High' },
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
