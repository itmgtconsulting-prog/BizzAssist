#!/usr/bin/env node
/**
 * Creates a JIRA ticket: align person → Ejendomme tab with
 * company → Ejendomme tab. Data source = person's diagram-tab
 * properties. Historical properties openable via toggle.
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
          text: 'Ejendomme-fanen på personsiden (/dashboard/owners/[enhedsNummer]) opfører sig anderledes end Ejendomme-fanen på virksomhedssiden. Den skal alignes med virksomheds-fanens mønster så brugeren oplever en konsistent UX på tværs af person- og virksomheds-detaljesiderne.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Reference — virksomhedsfanen' }],
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
                  text: 'URL: test.bizzassist.dk/dashboard/companies/41092807 (JaJR Holding ApS → Ejendomme)',
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
                  text: 'Layout: ejendomskort grupperet under hvert datterselskab (Arnbo 62 ApS, ArnBo 64b ApS, HP Properties ApS, JAJR Ejendomme 2 ApS), horisontal grid (BIZZ-569).',
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
                  text: 'Felter pr. kort: type-badge, BFE, bolig m², erhverv m², matrikel m², købspris + dato, grundværdi (gul) + år.',
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
                  text: '"Vis historik"-toggle øverst afslører solgte ejendomme grupperet under det oprindelige ejer-selskab (BIZZ-569).',
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
      content: [{ type: 'text', text: 'Ønsket adfærd — personfanen' }],
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
                  text: 'Brug SAMME komponent og layout som virksomheds-fanen: horisontal grid af PropertyOwnerCard, grupperet efter ejer-enhed.',
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
                { type: 'text', text: 'Data-kilde: ', marks: [] },
                {
                  type: 'text',
                  text: 'de samme ejendomme som vises på personens Diagram-fane',
                  marks: [{ type: 'strong' }],
                },
                {
                  type: 'text',
                  text: '. Dvs. både direkte personligt ejede ejendomme OG ejendomme ejet via personens holdingselskaber (som vises som noder i diagrammet).',
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
                  text: 'Gruppér kortene efter ejer-enheden (personen selv, hvert holdingselskab, hvert datter-/datter-dattervirksomhed). Samme visuelle sektion-headere som virksomhedssiden.',
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
                { type: 'text', text: 'Undtagelse fra diagram-reglen: ', marks: [] },
                {
                  type: 'text',
                  text: 'historiske (solgte) ejendomme kan åbnes via "Vis historik"-toggle',
                  marks: [{ type: 'strong' }],
                },
                {
                  type: 'text',
                  text: ', præcis som på virksomhedsfanen. Default skjult, synlige efter klik. På diagram-fanen er de stadig skjulte (jf. BIZZ-571).',
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
                  text: 'Alle datafelter og styling skal matche virksomhedsfanen 1:1 — brug samme komponent, ikke en parallel implementering.',
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
                  text: 'Refactor: ekstraher den fælles Ejendomme-fane-komponent fra virksomhedssiden til en delt komponent der tager en prop for data-kilde (enten CVR eller enhedsNummer).',
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
                  text: 'Data-fetch på person-side: genbrug /api/ejendomme-by-owner men forsyn den med personens egen enhedsNummer + en liste af datterselskab-CVR\'er (samme sæt som feeder diagrammet).',
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
                  text: 'Historik-toggle: filtrér aktiv === false på person-fanen (default skjult) — forskelligt fra diagram-fanen hvor de aldrig vises.',
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
                  text: 'Person-siden Ejendomme-fanen ligner virksomheds-fanen visuelt (ingen pixel-forskel i layout, typografi, farver).',
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
                  text: 'Ejendomme-listen på person-fanen matcher diagram-fanens ejendoms-noder 1:1 (samme antal, samme BFE\'er), grupperet efter ejer-enhed.',
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
                  text: '"Vis historik"-toggle afslører solgte ejendomme grupperet under det oprindelige ejer-selskab. Default skjult.',
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
                  text: 'Ingen regression på virksomhedsfanen — samme komponent bruges begge steder.',
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
                  text: 'Relaterer: BIZZ-569 (virksomhed Ejendomme-layout), BIZZ-571 (person-diagram align), BIZZ-546 (personligt ejede ejendomme vises ikke i virksomhedsdiagram), BIZZ-575 (BBR-arealer korrekthed — samme data-kilde).',
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
      'Person → Ejendomme: align layout + data-kilde med virksomheds-fanen (samme komponent, "Vis historik"-toggle)',
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
