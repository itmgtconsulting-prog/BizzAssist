#!/usr/bin/env node
/**
 * Creates a JIRA ticket for aligning the Energimærkerapporter section header
 * + download UI with the Dokumenter/Planer sections above it.
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
          text: 'På Dokumenter-fanen for en ejendom er ',
        },
        { type: 'text', text: 'Energimærkerapporter', marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: '-sektionen stylet anderledes end de øvrige dokument-sektioner ovenover (Dokumenter, Planer). Det skaber visuel inkonsistens og gør fanen sværere at scanne.',
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
              content: [{ type: 'text', text: 'Ejendom: Bibliotekvej 58, 2650 Hvidovre' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Tab: Dokumenter → scroll til bund' }] },
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
                  text: 'Dokumenter- og Planer-sektionerne har kolonne-overskrifter ÅR / DOKUMENT|TYPE / STATUS / DOK. og en checkbox + PDF-ikon for download-valg.',
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
                  text: 'Energimærkerapporter bruger helt andre kolonner (KLASSE / ADRESSE / STATUS / GYLDIG FRA / GYLDIG TIL / RAPPORT) med andet typografi, størrelse og spacing.',
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
                  text: 'PDF-ikonet og download-checkboxen i Energimærkerapporter-rækken sidder ikke aligned med de ovenstående sektioners DOK.-kolonne — ikoner/checkbox har forskellig højrejustering.',
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
      content: [{ type: 'text', text: 'Ønsket' }],
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
                  text: 'Energimærkerapporter-sektionen skal bruge SAMME kolonne-header-style (farve, case, tracking, størrelse) som Dokumenter og Planer.',
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
                  text: 'PDF-ikon + download-checkbox højrejusteret og lodret alignet med DOK.-kolonnen i de øvrige sektioner, så alle rækker på fanen har kolonne-symmetri.',
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
                  text: 'Section-titel "ENERGIMÆRKERAPPORTER" skal matche stilen for "PLANER" og "DOKUMENTER" (samme ikon-størrelse, padding, divider).',
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
                  text: 'Kolonnerne (Klasse / Adresse / Status / Gyldig fra / Gyldig til) bibeholdes — kun overskrifts-typografi og ikon-alignment rettes til.',
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
                  text: 'Alle 3 sektioner (Dokumenter, Planer, Energimærkerapporter) har visuelt identiske kolonne-headers.',
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
                  text: 'PDF-ikonet og download-checkboxen står på samme vertikale linje på tværs af alle rækker, uanset sektion.',
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
                  text: 'Download valgte-knappen øverst på fanen tæller også rapporter fra Energimærkerapporter-sektionen når deres checkbox sættes.',
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
    summary: 'Dokumenter: align energimærkerapporter-sektionen med dokumenter/planer (headers + pdf/download-ikon)',
    description,
    issuetype: { id: bugType.id },
    priority: { name: 'Low' },
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
