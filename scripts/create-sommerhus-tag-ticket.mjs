#!/usr/bin/env node
/**
 * Creates a JIRA ticket: incorrect "Sommerhus"-tag shown on a central
 * Copenhagen apartment (Thorvald Bindesbølls Plads 18, 3. th).
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
          text: 'Ejendommen Thorvald Bindesbølls Plads 18, 3. th, 1799 København V (en ejerlejlighed i centrum af København) er mærket med et ',
        },
        { type: 'text', text: '"Sommerhus"-tag', marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: ' i ejendomsheaderen. Det er åbenlyst forkert — en 3. sals lejlighed i København V er ikke et sommerhus.',
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
                  text: 'URL: test.bizzassist.dk/dashboard/ejendomme/dd4a90de-b126-4438-824f-3677efab2bd0',
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
                  text: 'Ejendom: Thorvald Bindesbølls Plads 18, 3. th, 1799 København V (BFE 100165718, ESR 101-39396)',
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
                { type: 'text', text: 'Type: Ejerlejlighed (korrekt) i Samlet ejendom' },
              ],
            },
          ],
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
      content: [{ type: 'text', text: 'Badges øverst efter adressen:' }],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '"Ejerlejlighed" ✓ (korrekt)' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '"Ejerbolig til vurdering i lige år" ✓' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: '"Sommerhus" ', marks: [] },
                { type: 'text', text: '← FORKERT', marks: [{ type: 'strong' }] },
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
                  text: 'Sommerhus-badge udledes formentlig fra VUR juridisk kategori-kode eller BBR benyttelseskode. Enten er datakilden selv forkert for denne ejerlejlighed, eller også fortolker vi en kode forkert.',
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
                  text: 'Check logikken: hvilket felt trigger "Sommerhus"-badgen? Kan det overstyre zoneindhold eller adresse-kontekst (1799 København V = byzone, tydeligvis ikke sommerhusområde)?',
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
                  text: 'Muligvis: "Sommerhus" kommer fra en flag i VUR der egentlig betyder "ejendommen vurderes som sommerhus" (skatteteknisk fritagelse eller lign.) — men det bør ikke vises som en property-type-badge der suggererer bygningen ER et sommerhus.',
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
                  text: 'Identificér hvilken datakilde/felt der trigger "Sommerhus"-badgen, og verificér at logikken er konsistent med virkeligheden.',
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
                  text: 'Tilføj sanity-check: hvis zone ≠ Sommerhuszone og BBR benyttelseskode ikke indikerer sommerhus (kode 510/540 typisk), skal "Sommerhus" ikke vises selv hvis VUR-flag er sat.',
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
                  text: 'Eventuelt omdøb badge-teksten — hvis flaget dækker "vurderes skattemæssigt som sommerhus" skal label afspejle det (f.eks. "Sommerhusbeskatning") i stedet for at foreslå at bygningen er et sommerhus.',
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
                  text: 'Thorvald Bindesbølls Plads 18, 3. th viser IKKE "Sommerhus"-badge.',
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
                  text: 'Ingen ejerlejlighed i byzone har "Sommerhus"-badge (test på 3-5 andre Copenhagen-ejerlejligheder).',
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
                  text: 'Regression-test: rigtige sommerhuse (sommerhuszone + BBR benyttelseskode 510/540) viser STADIG korrekt sommerhus-badge — fiksen må ikke skjule badgen for rigtige sommerhuse.',
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
                  text: 'Relaterer: BIZZ-550 (ejendomstype-badge forkert på Bibliotekvej 58) — samme familie af badge-klassifikations-bugs.',
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
      'Ejendomsbadge: "Sommerhus" vist forkert på ejerlejlighed i byzone (Thorvald Bindesbølls Plads 18, 3. th)',
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
