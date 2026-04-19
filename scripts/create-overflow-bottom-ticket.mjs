#!/usr/bin/env node
/**
 * Creates a JIRA ticket demanding overflow-ejendomsboxes be placed on the
 * BOTTOM LINE of the diagram without overlap — concrete constraint after
 * BIZZ-558 and BIZZ-563 both shipped but regressed.
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
          text: 'Overflow-ejendomsboksene ("+74 ejendomme", "+4 ejendomme") på Novo Nordisk-ejerskabsdiagrammet overlapper fortsat andre noder i diagrammet. Dette er 3. regression på samme issue — BIZZ-558 og BIZZ-563 blev begge lukket som løste, men overlappet er tilbage.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Eksplicit løsningskrav' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Overflow-boksene SKAL placeres på ', marks: [] },
        { type: 'text', text: 'nederste linje i diagrammet uden overlap', marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: ' — altså under alle øvrige noder, i en dedikeret "row" der ikke deler vertikalt space med nogen ejendoms- eller selskabsnoder.',
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
                { type: 'text', text: 'URL: test.bizzassist.dk/dashboard/companies/24256790' },
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
                  text: 'Observer "+74 ejendomme"-boksen midt i diagrammet samt "+4 ejendomme"-boksen i bunden til venstre — begge overlapper nabo-noder.',
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
      content: [{ type: 'text', text: 'Teknisk tilgang (forslag)' }],
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
                  text: 'Allokér en separat "overflow-row" NEDERST i diagram-layout — efter alle normale hierarkiske niveauer er placeret.',
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
                  text: 'Overflow-boksenes y-koordinat = max(y) af alle normale noder + padding. x-koordinat spredt ud på rækken.',
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
                  text: 'SVG viewBox udvides tilsvarende så overflow-rækken er synlig uden scroll ved default zoom.',
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
                  text: 'Linjer fra parent-noder til overflow-boksene bør tegnes med mindre visual weight (stiplet/gennemsigtig) så de ikke støjer på hierarkiet.',
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
                  text: 'Ingen overflow-boks overlapper nogen anden node på Novo Nordisk-diagrammet (testet ved default zoom 55% og ved zoom 100%).',
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
                  text: 'Alle overflow-bokse ("+N ejendomme") står på samme vandrette linje i bunden af diagrammet.',
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
                  text: 'Verificeres visuelt med Playwright-screenshot på test.bizzassist.dk FØR ticket transitioneres til Done — denne gang ingen "mærket done men regression" (jf. BIZZ-558/BIZZ-563).',
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
                  text: 'Verifikation sker på 3 forskellige virksomheder med overflow: Novo Nordisk (mange), JAJR Holding (få), og ét selskab uden overflow (regression-check at tom overflow-row ikke skaber ekstra padding).',
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
                  text: 'Relaterer: BIZZ-558 (oprindelig), BIZZ-563 (første regression). Denne ticket ER den 3. iteration.',
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
      'Diagram: placér overflow-ejendomsbokse på nederste linje uden overlap (3. regression — BIZZ-558/563)',
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
