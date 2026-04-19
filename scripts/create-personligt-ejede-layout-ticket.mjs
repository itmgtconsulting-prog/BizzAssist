#!/usr/bin/env node
/**
 * Creates JIRA ticket: personligt ejede ejendomme skal placeres på separat
 * linje, max 5 pr. linje, med ejerandel på forbindelses-linjen mellem
 * person-node og ejendoms-node.
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
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Problem' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Personligt ejede ejendomme på virksomhedsdiagrammet blandes i dag med virksomheds-noder og kan brede sig ud over flere rækker uden konsistent rytme. På JaJR Holding ApS-diagrammet ses Jakob Juul Rasmussen med 4 ejendomme på én linje (Thorvald Bindesbølls Plads 18, Hørsøltådevej 26, Kildegårdsvej 18D, H C Møllersvej 21) mens J.C. Jacobsens Gade 11 og Hovager 8 står på en anden række sammen med holdingselskaber. Layoutet er ikke struktureret.',
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Reproduktion' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'URL: test.bizzassist.dk/dashboard/companies/41092807 (JaJR Holding ApS → Diagram)' },
              ],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Ønsket adfærd' }] },
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
                { type: 'text', text: 'Personligt ejede ejendomme skal placeres på ', marks: [] },
                { type: 'text', text: 'en separat linje', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' under personen — ikke blandet med virksomheder i samme lag.' },
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
                { type: 'text', text: 'Max ', marks: [] },
                { type: 'text', text: '5 ejendomme pr. linje', marks: [{ type: 'strong' }] },
                { type: 'text', text: '. Ved flere end 5: wrap til næste linje (også personligt-ejet-dedikeret) med samme vertical spacing.' },
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
                { type: 'text', text: 'Ejerandel (fx 100%, 50%, 25%) skal vises ', marks: [] },
                { type: 'text', text: 'på forbindelses-linjen', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' mellem person-noden og hver ejendoms-boks — samme visuelle stil som ejerandel vises mellem virksomheder (grøn pille-label på edgen).' },
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
                  text: 'Forbindelses-linjerne fra person til personligt ejede ejendomme skal visuelt adskilles fra person→virksomheds-linjer (fx stiplet eller anden farve) så kategorien af relation er klar.',
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Teknisk tilgang' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'I diagram-layout: reserver dedikerede "personligt ejet ejendoms-rækker" direkte under hver person-node.' },
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
                { type: 'text', text: 'Layout-logik: chunk ejendomsliste i grupper af 5 → hver gruppe = én række under personen. Rækker stackes vertikalt.' },
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
                { type: 'text', text: 'Edge-label: udvid nuværende %-label-renderer til også at acceptere person→ejendom-edges. Data kommer fra EJF ejerandel_taeller/naevner.' },
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
                  text: 'Fortrin: anvend samme regel på både virksomhedsdiagram og persondiagram (jf. BIZZ-571 alignment).',
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'På JaJR Holding ApS-diagrammet: Jakobs 6 personligt ejede ejendomme (eller N ejendomme) placeres på 1-2 dedikerede rækker (5 + resten) direkte under ham.' },
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
                { type: 'text', text: 'Hver forbindelseslinje person → ejendom har sin ejerandel påført som label (fx 100%).' },
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
                { type: 'text', text: 'Virksomheder og personligt ejede ejendomme blandes ikke i samme lag — visuel adskillelse er klar.' },
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
                { type: 'text', text: 'Regression-test: personer uden personligt ejede ejendomme (kun virksomheder) har ingen tom "ejendoms-række" — layoutet skrumper pænt.' },
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
                { type: 'text', text: 'Relaterer: BIZZ-581 (personligt ejede ejendomme format+klik), BIZZ-582 (udvid + alignment), BIZZ-568 (overflow-bokse bottom-row), BIZZ-571 (person-diagram align).' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const res = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    summary: 'Diagram: personligt ejede ejendomme på separat linje (max 5 pr. linje) + ejerandel på forbindelses-linjen',
    description,
    issuetype: { id: bugType.id },
    priority: { name: 'Medium' },
  },
});
if (res.status === 201) {
  const key = JSON.parse(res.body).key;
  console.log(`Created: ${key}`);
  console.log(`URL: https://${HOST}/browse/${key}`);
} else {
  console.log(`FAILED (${res.status}):`, res.body.slice(0, 500));
}
