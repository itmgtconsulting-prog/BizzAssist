#!/usr/bin/env node
/**
 * Splits BIZZ-557 into two tickets:
 *   (A) Technical — EJF drill-down from hovedejendom-BFE to specific ejerlejlighed-BFE'er
 *   (B) UI — display etage/dør + Ejerlejlighed-badge when CVR owns specific apartment
 * Then closes BIZZ-557 with comment linking to both.
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
const taskType =
  types.find((t) => /^task$/i.test(t.name)) ??
  types.find((t) => /^bug$/i.test(t.name)) ??
  types.find((t) => !t.subtask);

// ────────────────── Ticket A: Technical EJF drill-down ──────────────────
const descA = {
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
          text: 'Når et CVR ejer en specifik ejerlejlighed, returnerer EJF (Ejerfortegnelsen) i dag hovedejendommens BFE ("samlet fast ejendom") — ikke ejerlejlighedens BFE. Det betyder at visningen peger på en BFE der ikke kan renderes som en selvstændig ejendom (ingen etage/dør, /dashboard/ejendomme/[BFE] returnerer ikke-fundet), og brugeren ser forkerte badges og data.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Teknisk omfang' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Implementér drill-down-logik i ', marks: [] },
        { type: 'text', text: 'app/api/ejendomme-by-owner/route.ts', marks: [{ type: 'code' }] },
        { type: 'text', text: ' / tilhørende enrich-endpoint:' },
      ],
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
                  text: 'Detektér at en returneret BFE er en hovedejendom: EJF_Ejendom.hovednoteringsnummer = "samlet fast ejendom" + ingen tilhørende ejerlejlighed-enhed / ingen etage-dør-metadata.',
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
                  text: 'Slå alle ejerlejligheder under samme hovednoteringsnummer op via EJF (EJF_Ejendom med hovednoteringsnummer = hovedejendommens nummer).',
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
                  text: 'For hver ejerlejlighed: slå ejerskab op (EJF_Ejerskab / EJF_Adkomstanmeldelse) og filtrér til dem der ejes af det konkrete CVR.',
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
                  text: 'Erstat hovedejendom-BFE i svar-payloaden med ejerlejlighed-BFE\'erne (kan være flere hvis CVR ejer flere lejligheder i samme blok).',
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
                  text: 'Cache resultatet per CVR + hovedejendom for at undgå gentagne EJF-opslag.',
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
                  text: '/api/ejendomme-by-owner for JAJR Ejendomme ApS returnerer den specifikke ejerlejlighed-BFE på Kaffevej 31 (ikke hovedejendom-BFE 425.479).',
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
                  text: 'Når CVR ejer flere ejerlejligheder i samme hovedejendom, returneres alle som separate entries.',
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
                  text: 'Ingen regression: virksomheder der faktisk ejer hovedejendomme (fx Novo Nordisk erhvervsejendomme) returnerer stadig hovedejendom-BFE\'et.',
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
                  text: 'Performance: drill-down-opslag cachet så samme virksomhedssøgning ikke laver N+1 EJF-kald.',
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
                  text: 'Opdelt fra BIZZ-557. UI-delen (vis etage/dør + Ejerlejlighed-badge) håndteres i søster-ticket — denne ticket leverer kun datagrundlaget.',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

console.log('→ Creating Ticket A (EJF drill-down)…');
const resA = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    summary:
      'EJF drill-down: returnér ejerlejlighed-BFE i stedet for hovedejendom-BFE når CVR ejer specifik enhed',
    description: descA,
    issuetype: { id: taskType.id },
    priority: { name: 'Medium' },
  },
});
if (resA.status !== 201) {
  console.error('Ticket A failed:', resA.body.slice(0, 500));
  process.exit(1);
}
const keyA = JSON.parse(resA.body).key;
console.log(`  Created ${keyA}`);

// ────────────────── Ticket B: UI — etage/dør + badge ──────────────────
const descB = {
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
          text: 'Når EJF returnerer en ejerlejlighed-BFE (jf. søster-ticket ' + keyA + '), skal UI\'et vise ejerlejlighedens korrekte metadata: etage + dør i adressen, "Ejerlejlighed"-badge, og klik skal føre til ejerlejlighedens detaljeside. I dag vises adressen uden etage/dør og med badge "Ejerbolig til vurdering i lige år" selvom det er en ejerlejlighed.',
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
              content: [{ type: 'text', text: 'Ejendom: Kaffevej 31, 2610 Rødovre' }],
            },
          ],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Ønsket UI-adfærd' }],
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
                  text: 'Adressen viser etage + dør: "Kaffevej 31, X. sal, Y" (fx "Kaffevej 31, 3. tv").',
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
                  text: 'Badge skifter fra "Ejerbolig til vurdering i lige år" til "Ejerlejlighed" (eller kombination hvis begge gælder).',
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
                  text: 'Vurdering afspejler ejerlejligheden, ikke hele bygningen.',
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
                  text: 'Klik på kortet fører til ejerlejlighedens detaljeside (/dashboard/ejendomme/[ejerlejlighed-BFE]), ikke til den uvisbare hovedejendom-BFE.',
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
      content: [{ type: 'text', text: 'Berørte filer' }],
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
                  text: 'app/components/ejendomme/PropertyOwnerCard.tsx — adresse-rendering (etage/dør-sammensætning findes allerede for BIZZ-551; verificér at den også triggers her)',
                  marks: [{ type: 'code' }],
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
                  text: 'app/api/ejendomme-by-owner/route.ts — DAWA BFE-opslag (udvid med etage/dør fra enhedsadresse)',
                  marks: [{ type: 'code' }],
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
      content: [{ type: 'text', text: 'Afhængighed' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Afventer ' },
        { type: 'text', text: keyA, marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: ' (EJF drill-down) — uden den leverer backend stadig hovedejendom-BFE og UI kan ikke rendre korrekt.',
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
                  text: 'Kaffevej 31 under JAJR Ejendomme ApS viser etage + dør i adressen.',
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
              content: [{ type: 'text', text: 'Badge viser "Ejerlejlighed".' }],
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
                  text: 'Klik på kortet fører til ejerlejlighedens detaljeside (ikke 404).',
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
                  text: 'Opdelt fra BIZZ-557. Relaterer: BIZZ-551 (hovedejendom vs ejerlejlighed pattern).',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

console.log('→ Creating Ticket B (UI etage/dør + badge)…');
const resB = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    summary: 'Ejendomskort: vis etage/dør + Ejerlejlighed-badge på Kaffevej 31 (efter EJF drill-down)',
    description: descB,
    issuetype: { id: taskType.id },
    priority: { name: 'Medium' },
  },
});
if (resB.status !== 201) {
  console.error('Ticket B failed:', resB.body.slice(0, 500));
  process.exit(1);
}
const keyB = JSON.parse(resB.body).key;
console.log(`  Created ${keyB}`);

// ────────────────── Close BIZZ-557 with comment ──────────────────
console.log('\n→ Commenting + transitioning BIZZ-557 to Done…');
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Opdelt i to tickets 2026-04-19:', marks: [{ type: 'strong' }] },
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
                  { type: 'text', text: keyA, marks: [{ type: 'strong' }] },
                  {
                    type: 'text',
                    text: ' — EJF drill-down fra hovedejendom-BFE til specifik ejerlejlighed-BFE (teknisk/backend).',
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
                  { type: 'text', text: keyB, marks: [{ type: 'strong' }] },
                  {
                    type: 'text',
                    text: ' — vis etage/dør + Ejerlejlighed-badge på kortet (UI, afhænger af søster-ticket).',
                  },
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
            text: 'Lukker denne som "split into two" — arbejdet fortsætter i de to nye tickets.',
            marks: [{ type: 'em' }],
          },
        ],
      },
    ],
  },
};
await req('POST', '/rest/api/3/issue/BIZZ-557/comment', comment);

// Transition to Done
const trRes = await req('GET', '/rest/api/3/issue/BIZZ-557/transitions');
const transitions = JSON.parse(trRes.body).transitions || [];
const done = transitions.find((t) => /^done$/i.test(t.name) || /^done$/i.test(t.to?.name ?? ''));
if (done) {
  const dr = await req('POST', '/rest/api/3/issue/BIZZ-557/transitions', {
    transition: { id: done.id },
  });
  console.log(`  BIZZ-557 → Done (id=${done.id}) HTTP ${dr.status}`);
} else {
  console.log('  No Done transition found — manual close needed');
}

console.log(`\nDone. New tickets:\n  ${keyA} (EJF drill-down)\n  ${keyB} (UI etage/dør + badge)`);
console.log(`  BIZZ-557 closed as "split into two"`);
