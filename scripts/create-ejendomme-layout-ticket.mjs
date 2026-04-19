#!/usr/bin/env node
/**
 * Creates a JIRA ticket for restructuring the company Ejendomme tab:
 *  - Horizontal grid layout for property cards
 *  - Expanded data columns below BFE line
 *  - Historical (sold) properties toggle
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
          text: 'Ejendomme-fanen på en virksomhed (fx JaJR Holding 2 ApS) har tre problemer med layout og data: kortene stacker kun vertikalt i stedet for at fylde horisontalt, felterne under BFE-linjen viser ikke tilstrækkelig info, og historiske (solgte) ejendomme er ikke grupperet under deres ejer-virksomhed + vises altid uanset filter.',
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
                { type: 'text', text: 'Virksomhed: JaJR Holding 2 ApS (CVR 44878704)' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tab: Ejendomme' }] }],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: '1. Layout: horisontal grid i stedet for vertikal stack' }],
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
                  text: 'Ejendomskort skal flow HORISONTALT først (fx 3-4 kolonner på desktop), derefter nedad når rækken er fyldt — ikke én enkelt kolonne der scroller hele vejen ned.',
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
                  text: 'Responsive: 1 kolonne på mobile, 2 på tablet, 3-4 på desktop (grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4).',
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
      content: [{ type: 'text', text: '2. Info under BFE-linjen' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Feltet under stregen (under BFE-nummer) skal indeholde følgende, gerne med ikoner:',
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
                { type: 'text', text: 'Salgspris', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' (seneste tinglyste handel — 🛒 shopping-cart ikon)' },
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
                { type: 'text', text: 'Seneste foreløbige vurdering', marks: [{ type: 'strong' }] },
                {
                  type: 'text',
                  text: ' med årstal — i GUL tekst (matcher "FORELØBIG"-badge i resten af app\'en). 📈 trending-up ikon.',
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
                { type: 'text', text: 'Bolig m²', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' (🏠 home ikon)' },
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
                { type: 'text', text: 'Erhverv m²', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' (🏢 building ikon)' },
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
                { type: 'text', text: 'Matrikel m²', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' (📐 ruler eller 🗺️ map ikon)' },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Reference-styling: se ejendomskort på top-screenshot af ticket (Arnold Nielsens Boulevard 66B-kortet) — samme tæthed, samme icon-størrelse, samme label-typografi.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: '3. Historiske (solgte) ejendomme' }],
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
                  text: 'Historiske ejendomme (aktiv = false, med solgtDato) skal GRUPPERES under den virksomhed de tilhørte — i samme sektion som virksomhedens aktive ejendomme, men visuelt dæmpet (grå/opacity-60 — samme styling som de eksisterende "solgt"-kort).',
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
                  text: 'De skal kun vises når brugeren klikker en "Vis historik"-knap ØVERST på fanen — default er skjult.',
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
                  text: 'Knap-label: "Vis historik (N)" når skjult, "Skjul historik" når vist. N = antal historiske ejendomme på tværs af alle datterselskaber.',
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
                  text: 'Inden for en sektion: aktive ejendomme først, historiske efter, separeret med et diskret "Historiske (N)"-subheader.',
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
                  text: 'JaJR Holding 2 ApS Ejendomme-fanen viser 3-4 kolonner af ejendomskort på desktop.',
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
                  text: 'Hvert kort viser salgspris + foreløbig vurdering (gul+år) + bolig m² + erhverv m² + matrikel m² med ikoner.',
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
                  text: 'Historiske ejendomme skjult default; "Vis historik (N)"-knap øverst afslører dem grupperet under deres respektive datterselskaber.',
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
                  text: 'Relaterer: BIZZ-475 (Vis historik-knap for tidligere ejede virksomheder), BIZZ-556 (PropertyOwnerCard labels).',
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
      'Virksomhed → Ejendomme: horisontal grid, udvidede datafelter, "Vis historik"-toggle for solgte',
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
