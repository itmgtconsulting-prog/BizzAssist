#!/usr/bin/env node
/**
 * Creates a JIRA ticket for the diagram refactor (shared DiagramRenderer
 * component) and transitions it to On Hold. Parkeret — tages op når
 * diagram-bug-klyngen er 10+ tickets eller en tredje kontekst tilføjes.
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
const taskType =
  types.find((t) => /^task$/i.test(t.name)) ??
  types.find((t) => /^bug$/i.test(t.name)) ??
  types.find((t) => !t.subtask);

const description = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Baggrund' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Der er en voksende klynge af diagram-bugs der alle peger på samme underliggende arkitektur-valg: person- og virksomhedsdiagrammet har separate implementeringer, hvilket fører til at bugs fixes kun ét sted og at ny funktionalitet drifter mellem de to. Virksomhedsdiagrammet virker godt i dag — denne ticket beskriver hvordan vi kan refactore til én delt renderer UDEN regression.',
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Parkering' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Ticketen er ', marks: [] },
        { type: 'text', text: 'On Hold', marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: ' indtil mindst ét af følgende er sandt: (1) diagram-bug-klyngen er 10+ åbne tickets, (2) en tredje diagram-kontekst (fx ejendom-centreret eller koncern-oversigt) skal tilføjes, (3) refactoren bliver blokker for en konkret feature. Indtil da fixes bugs direkte på den eksisterende kode for begge sider.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Arkitektur — hybrid deling' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Ikke fuld monolitisk sammensmeltning. Plugin-baseret struktur hvor ca. 60 % af kompleksiteten deles:',
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
                { type: 'text', text: 'Delt: ', marks: [{ type: 'strong' }] },
                {
                  type: 'text',
                  text: 'layout-algoritme, zoom/pan/viewport, toolbar, overflow-gruppering (+N-bokse), udvid-knap-state, fullscreen, tastatur-shortcuts.',
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
                { type: 'text', text: 'Separat: ', marks: [{ type: 'strong' }] },
                {
                  type: 'text',
                  text: 'node-rendering (forskellige felter pr. type: person/company/ejendom), data-fetch-hooks (CVR vs EJF), context-specifikke features (fx personroller-liste kun på person).',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'API-skitse:' }],
    },
    {
      type: 'codeBlock',
      attrs: { language: 'typescript' },
      content: [
        {
          type: 'text',
          text: `<DiagramRenderer
  rootNode={personOrCompany}
  renderNode={(node) => {
    switch (node.type) {
      case 'person':  return <PersonCard {...node} />;
      case 'company': return <CompanyCard {...node} />;
      case 'ejendom': return <EjendomCard {...node} />;
    }
  }}
  renderEdge={(edge) => <EdgeLabel pct={edge.andel} kind={edge.kind} />}
  config={{ overflowThreshold: 5, showAddresses: true }}
/>`,
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Faseplan (rækkefølge er obligatorisk)' }],
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
                  text: 'Fase 0 — Baseline tests (~1 dag).',
                  marks: [{ type: 'strong' }],
                },
                {
                  type: 'text',
                  text: ' Playwright snapshot-tests af 4 kendte virksomhedsdiagrammer (JaJR Holding, Novo Nordisk, lille med 1 ejendom, tomt). E2E-test af alle toolbar-funktioner. MÅ IKKE preces videre før testene er grønne.',
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
                  text: 'Fase 1 — Extract uden adfærdsændring (~2-3 dage).',
                  marks: [{ type: 'strong' }],
                },
                {
                  type: 'text',
                  text: ' Kopiér virksomhedsside-diagrammet ordret til ny DiagramRenderer. Gør virksomhedssiden til tynd wrapper der kalder DiagramRenderer med virksomheds-renderer-callbacks. Fase 0-tests skal stadig være grønne efter denne fase.',
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
                  text: 'Fase 2 — Tilføj person-context (~2-3 dage).',
                  marks: [{ type: 'strong' }],
                },
                {
                  type: 'text',
                  text: ' Introducér persondiagrammet via samme DiagramRenderer med person-renderer-callbacks. Person-logikken er udelukkende additiv — rører ikke virksomheds-flow.',
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
                  text: 'Fase 3 — Gradvis de-dup (løbende).',
                  marks: [{ type: 'strong' }],
                },
                {
                  type: 'text',
                  text: ' Hvor der er kopi-kode mellem person- og company-render kan det gradvist slås sammen. Hver konsolidering er en separat commit med egen test-run.',
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
      content: [{ type: 'text', text: 'Regression-vagter' }],
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
                  text: 'Snapshot-test (pixel-diff ≤ 1 %) af 4 kendte virksomhedsdiagrammer — kører før hver merge.',
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
                  text: 'E2E: zoom, pan, udvid, skjul, overflow, ejendomme-toggle, fullscreen, dobbeltklik-zoom.',
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
                  text: 'Feature-flag (fx NEXT_PUBLIC_DIAGRAM_V2) der kan skifte tilbage til gammel kode-sti ved regression i produktion.',
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
                  text: 'Interaktiv review-liste: kendt-god adfærd dokumenteret (fx "udvid Novo Nordisk ser sådan ud") — reviewer følger manuelt.',
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Tidsestimat' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fase 0: ~1 dag' }] }],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Fase 1: 2-3 dage (lav risiko)' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fase 2: 2-3 dage' }] }],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Fase 3: løbende, per delticket' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Total første stabile version: ~1-2 uger' }],
            },
          ],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [
        { type: 'text', text: 'Berørte diagram-bugs (vil blive nemmere at rette efter refactor)' },
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
                { type: 'text', text: 'BIZZ-571 — person-diagram align med virksomhedsdiagram' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'BIZZ-582 — Udvid-knap + fuld alignment' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'BIZZ-586 — person-node foldes ud + fuld alignment' },
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
                { type: 'text', text: 'BIZZ-581 — personligt ejede ejendomsbokse format + klik' },
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
                  text: 'BIZZ-585 — personligt ejede ejendomme på separat linje + ejerandel',
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
                { type: 'text', text: 'BIZZ-568 — overflow-bokse bottom-row (3. regression)' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'BIZZ-573 — filtrér reelle ejere fra' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'BIZZ-564 — JAJR Ejendomme 2 ejerkæde' }],
            },
          ],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Acceptance criteria (når refactor aktiveres)' }],
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
                  text: 'Fase 0 snapshot-tests + E2E-tests passer på virksomhedssiden før refactor begynder.',
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
                  text: 'Efter Fase 1: virksomhedssiden opfører sig pixel-identisk med før refactor — verificeret med snapshot-diff.',
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
                  text: 'Efter Fase 2: persondiagrammet har mindst samme toolbar-funktionalitet som virksomhedsdiagrammet.',
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
                  text: 'Feature-flag gør det muligt at rulle tilbage til gammel kode-sti med én env-ændring.',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

console.log('→ Creating refactor ticket…');
const res = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    summary:
      'Diagram-refactor: delt diagramrenderer-komponent for person- og virksomhedsside (hybrid, faseplan, regression-vagter)',
    description,
    issuetype: { id: taskType.id },
    priority: { name: 'Medium' },
  },
});
if (res.status !== 201) {
  console.error('FAILED:', res.body.slice(0, 500));
  process.exit(1);
}
const key = JSON.parse(res.body).key;
console.log(`  Created ${key}`);

console.log('\n→ Transitioning to On Hold…');
const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
const transitions = JSON.parse(tr.body).transitions || [];
const onHold = transitions.find(
  (t) => /^on hold$/i.test(t.name) || /^on hold$/i.test(t.to?.name ?? '')
);
if (!onHold) {
  console.log('  Options:', transitions.map((t) => t.name).join(', '));
  process.exit(1);
}
const dr = await req('POST', `/rest/api/3/issue/${key}/transitions`, {
  transition: { id: onHold.id },
});
console.log(`  Transitioned → On Hold (id=${onHold.id}) HTTP ${dr.status}`);
console.log(`\nDone. ${key} — https://${HOST}/browse/${key}`);
