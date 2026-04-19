#!/usr/bin/env node
/**
 * Creates a JIRA ticket: PropertyOwnerCard on company Ejendomme tab shows
 * incorrect BBR areal-data (bolig/erhverv/matrikel/vurdering) because
 * enrich-endpoint fetches across all buildings on husnummer instead of
 * restricting to the specific BFE, and doesn't match ejendomsside logic.
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
          text: 'Data i ejendomskortene på Virksomhed → Ejendomme-fanen (bolig m², erhverv m², matrikel m², vurdering) matcher ikke det der vises på selve ejendomssiden. Tallene er ofte oppustede — typisk fordi enrich-endpointet aggregerer på tværs af alle bygninger på adgangsadressen frem for at begrænse til den specifikke BFE.',
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
                { type: 'text', text: 'URL: test.bizzassist.dk/dashboard/companies/44878704' },
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
                { type: 'text', text: 'Virksomhed: JaJR Holding 2 ApS → Ejendomme-fanen' },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Observeret diskrepans' }],
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
                { type: 'text', text: 'Bibliotekvej 58 ejendomskort viser ', marks: [] },
                { type: 'text', text: 'Erhv: 4.596 m²', marks: [{ type: 'strong' }] },
                {
                  type: 'text',
                  text: ' + Matr: 1.609 m². Men på selve ejendomssiden (BBR-fanen) er erhvervsarealet kun 1.149 m² og bygningsarealet 1.124 m² — tallet på kortet er ~4x det reelle.',
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
                  text: 'Flere andre kort viser ejendomsværdier i 20-30 mio DKK (2025) selvom de foreløbige vurderinger endnu er 0 DKK for erhvervsejendomme — grundværdien bruges som fallback uden label.',
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
      content: [{ type: 'text', text: 'Årsag (kode-review)' }],
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
                  text: 'app/lib/fetchBbrData.ts:666 ',
                  marks: [{ type: 'code' }],
                },
                {
                  type: 'text',
                  text: ' — fetchBbrAreasByDawaId() filtrerer BBR_Bygning på husnummer = dawaId og SUMMERER areal-felter på tværs af alle bygninger. Men samme husnummer kan dække flere BFE\'er (komplekser, ejerlejligheder), så tallet bliver for højt.',
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
                  text: 'Ingen status-filter: nedrevne/slettede bygninger (status=7) inkluderes også i summen.',
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
                  text: 'Ejendomsside-logikken (fetchBbrForAddress i samme fil) gør det rigtigt: den følger BFE-Krydsreference, filtrerer status og aggregerer kun bygninger der tilhører den konkrete ejendom. Enrich-endpointet skal bruge samme kilde.',
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
      content: [{ type: 'text', text: 'Ønsket fix' }],
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
                  text: 'Refactor fetchBbrAreasByDawaId: skift til at følge BFE → bygnings-IDs via BBR_Ejendomsrelation (samme vej som fetchBbrForAddress) og aggregere kun over de bygninger der faktisk tilhører BFE\'et.',
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
                  text: 'Filtrér bygninger på status (bevar kun aktive, udeluk status=7 "nedrevet/slettet").',
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
                  text: 'For ejerlejligheder (BFE er en ejerlejlighed, ikke samlet ejendom): returnér den specifikke enheds areal, ikke hele bygningens sum.',
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
                  text: 'For vurdering: hvis ejendomsværdi(2025) er 0 DKK, vis "Grundværdi: X DKK" tydeligt i stedet for at lade brugeren tro det er ejendomsværdien.',
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
                  text: 'Bibliotekvej 58-kort viser Erhv: 1.149 m² (match med ejendomsside BBR-fanen), Matr: 1.609 m², Kælder: 83 m² hvis plads.',
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
                  text: 'Arealerne på ALLE ejendomskort på JaJR Holding 2 ApS matcher 1:1 med arealerne på den respektive ejendomsside (spot-check 3 ejendomme).',
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
                  text: 'Vurdering på kortet matcher den foreløbige vurdering der vises på ejendomsside Økonomi-fanen. Hvis ejendomsværdi er 0, vises label "Grundv." i stedet for "Vurd.".',
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
                  text: 'Nedrevne/slettede bygninger indgår ikke i summen.',
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
                  text: 'Relaterer: BIZZ-569 (udvidede property-datafelter), BIZZ-570 (creditor-ejendomme viser samme data), BIZZ-556 (ejendomskort-labels). Disse skal bruge samme korrekte data-layer.',
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
      'Ejendomskort på virksomhed viser forkerte bbr-arealer — align enrich-logik med ejendomsside-logik',
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
