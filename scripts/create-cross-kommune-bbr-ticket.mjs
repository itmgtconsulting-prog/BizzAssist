#!/usr/bin/env node
/**
 * Creates a JIRA ticket documenting the cross-kommune BBR misclassification
 * bug fixed in commit 84a898d (fetchBbrData.ts adresser-fallback).
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
          text: 'Parcelhuse blev nogle gange klassificeret som "Ejendommen er opdelt i ejerlejligheder" på Ejerstruktur-fanen. Konkret eksempel: Søbyvej 11, 2650 Hvidovre (parcelhus, jordBfe 2081243) viste empty-state for moderejendom og fik tilmed en falsk Ejerlejlighed-badge på header.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Root cause' }],
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
                  text: 'fetchBbrData har 2 trin: 1a) /adgangsadresser/{id} (hvis input er adgangsadresse-id), 1b) /adresser/{id} (hvis input er adresse-id med etage/dør).',
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
                  text: 'Variablen adgKommunekode blev kun sat i Trin 1a. Når DAWA returnerede 404 for adgangsadresse-pathen og koden faldt tilbage til Trin 1b, var adgKommunekode = null.',
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
                  text: 'Cross-kommune-validering i Vurderingsportalen-EL-detektion (`if (adgKommunekode) { … verify candidate kommune … }`) sprang derfor over.',
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
                  text: 'Vurderingsportalen-søgning på "Søbyvej 11" returnerede en hit fra Søbyvej 11, 7840 Højslev (Skive, BFE 4050546) — denne blev accepteret som ejerlejligheds-BFE. Resultat: erModer = true → empty-state med forkert ejerstruktur.',
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
      content: [{ type: 'text', text: 'Fix' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Sæt også adgKommunekode = adr.adgangsadresse?.kommune?.kode i Trin 1b (/adresser/{id}). Cross-kommune-valideringen kører nu uanset hvilken DAWA-vej der bruges. Implementeret i commit 84a898d (app/lib/fetchBbrData.ts).',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Reproduktion (før fix)' }],
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
                  text: 'URL: test.bizzassist.dk/dashboard/ejendomme/0a3f50a5-9af3-32b8-e044-0003ba298018 (Søbyvej 11, 2650 Hvidovre)',
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
                  text: 'Header viste BFE 4050546 (Skive) i stedet for 2081243 (Hvidovre matrikel 29ck) + falsk Ejerlejlighed-badge.',
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
                  text: 'Ejerstruktur-fanen viste "Ejendommen er opdelt i ejerlejligheder" empty-state.',
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
                  text: 'Søbyvej 11, 2650 Hvidovre viser BFE 2081243 i headeren (ikke 4050546).',
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
                  text: 'Ingen falsk Ejerlejlighed-badge på parcelhus-headeren.',
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
                  text: 'Ejerstruktur-fanen viser den faktiske ejerkæde, ikke "opdelt i ejerlejligheder" empty-state.',
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
                  text: 'Regression-check: rigtige ejerlejligheder (med etage/dør) detekteres stadig korrekt — fx Diamantgangen 67 og Bibliotekvej 58.',
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
      'BBR: parcelhuse fejlklassificeres som ejerlejligheder pga. manglende kommune-validering i adresser-fallback',
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
