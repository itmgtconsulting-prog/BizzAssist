#!/usr/bin/env node
/**
 * Creates a JIRA ticket: Udvid-knappen på person-diagrammet skal også
 * udvide personligt ejede virksomheder OG ejendomme under person-noden.
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
          text: 'På person-diagrammet (fx /dashboard/owners/4000115446 for Jakob Juul Rasmussen) virker Udvid-knappen ikke på person-noden selv. Den udvider kun virksomheds-noderne nedad. Det betyder at personens ',
        },
        {
          type: 'text',
          text: 'personligt ejede virksomheder og ejendomme',
          marks: [{ type: 'strong' }],
        },
        {
          type: 'text',
          text: ' aldrig vises via Udvid-mekanismen — kun dem der ejes via holdingselskaber fremgår.',
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
                  text: 'URL: test.bizzassist.dk/dashboard/owners/4000115446 (Jakob Juul Rasmussen)',
                },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Tab: Diagram' }] },
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
                  text: 'Klik "Udvid" øverst → kun virksomheds-noder lavere i hierarkiet udvides. Person-noden Jakob Juul Rasmussen er statisk og får aldrig personligt ejede virksomheder/ejendomme tegnet under sig.',
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
                  text: 'Udvid-knappen SKAL også udvide person-noden — vis alle virksomheder hvor personen er direkte ejer/deltager OG alle ejendomme tinglyst direkte på personen (ikke via holdingselskaber).',
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
                  text: 'Brug samme ekspanderings-interaktion som på virksomheds-noder: klik "Udvid" på toolbar for batch-ekspansion, eller klik på "+ Udvid N"-knap på selve person-noden for kun at udvide den.',
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
                  text: 'Kildedata: CVR deltagerRelation for personens enhedsNummer (giver virksomheder hvor personen ejer direkte) + EJF (giver ejendomme tinglyst på personen).',
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
                  text: 'Filtrér: personligt ejede ejendomme må IKKE vises hvis "ejendomme"-toggle er deaktiveret (jf. BIZZ-571 der sætter default off på person-siden).',
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
      content: [{ type: 'text', text: 'Alignment-check — virksomhedsdiagram som udgangspunkt' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Ud over Udvid-knappen skal ALLE settings og funktioner på virksomhedsdiagram (CVR-siden) være alignet på person-diagrammet. Tag virksomhedsdiagrammet som sandhedskilde og verificér 1:1:',
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
                {
                  type: 'text',
                  text: 'Zoom +/- / slider: samme trin + default zoom',
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
                  text: 'Centrér-knap: centrerer om root-noden med samme offset',
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
                { type: 'text', text: 'Reset-knap: samme default-state på begge sider' },
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
                { type: 'text', text: 'Udvid / Skjul-toggle: samme label og state-maskine' },
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
                { type: 'text', text: 'Ejendomme-toggle: samme default (jf. BIZZ-571 — off på person)' },
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
                { type: 'text', text: 'Fullscreen-knap: samme adfærd' },
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
                { type: 'text', text: 'Pan/træk: samme mouse-event-håndtering (jf. BIZZ-555)' },
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
                { type: 'text', text: 'Dobbeltklik for zoom: samme zoom-niveau / destination' },
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
                  text: 'Overflow-bokse ("+N ejendomme"): samme layout, udvid-regel, bottom-row-placering (jf. BIZZ-568)',
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
                  text: 'Node-styling: samme farvekode, badges, adresse-format for ejendomme',
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
      content: [{ type: 'text', text: 'Teknisk tilgang' }],
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
                  text: 'Refactor: fælles DiagramRenderer-komponent (jf. BIZZ-571) skal håndtere Udvid på både virksomheds- og person-rodnoder. Forskellen ligger kun i data-kilden.',
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
                  text: 'Data-layer for person-ekspansion: /api/ejendomme-by-owner med personens enhedsNummer + CVR-deltagerRelation-opslag for direkte ejerskaber.',
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
                  text: 'Klik Udvid på Jakob Juul Rasmussen-person-siden → alle hans personligt ejede virksomheder OG ejendomme (med ejendomme-toggle på) fremgår under person-noden.',
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
                  text: 'Alle toolbar-knapper (+/- / Centrér / Reset / Udvid / Skjul / Ejendomme-toggle / Fullscreen) virker identisk på virksomheds- og person-diagrammet.',
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
                  text: 'Overflow-bokse + dobbeltklik-zoom + pan adfærd 1:1 med virksomhedsdiagrammet.',
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
                  text: 'Relaterer: BIZZ-571 (person-diagram alignment), BIZZ-546 (personligt ejede ejendomme mangler i virksomhedsdiagram — On Hold), BIZZ-568 (overflow bottom-row), BIZZ-555 (pan/træk).',
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
      'Diagram: udvid-knap på person-node skal udvide personligt ejede virksomheder+ejendomme + fuld alignment med virksomhedsdiagram',
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
