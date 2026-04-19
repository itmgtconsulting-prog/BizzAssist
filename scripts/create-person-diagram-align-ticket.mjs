#!/usr/bin/env node
/**
 * Creates a JIRA ticket: align person-diagram rules with company-diagram
 * (hide historical ejendomme, default ejendomme-toggle off, expandable
 * overflow boxes, consistent behaviour).
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
          text: 'Person-ejerskabsdiagrammet (fx Jakob Juul Rasmussen) har andre regler end virksomheds-diagrammet: ejendomme vises default (ikke toggle-styret), historiske ejendomme optræder sammen med aktive, og overflow-bokse opfører sig inkonsistent. Person-diagrammet skal BEHOLDE sin unikke information om personens roller i virksomheder, men ellers opføre sig på samme måde som virksomheds-diagrammet.',
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
                { type: 'text', text: 'URL: test.bizzassist.dk/dashboard/owners/4000115446' },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Person: Jakob Juul Rasmussen' }] },
          ],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tab: Diagram' }] }],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Skal beholdes' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Person-diagrammet skal fortsat vise personens relationer til virksomheder og rollerne i dem (direktør, bestyrelsesmedlem, ejer etc.). Fx Pharma Lab CRO ApS og Radyx Pharma Tech ApS med listet personer og roller — denne ekstra personliste er unik for person-diagrammet og fjernes IKKE.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Skal alignes med virksomheds-diagram' }],
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
                { type: 'text', text: 'Historiske ejendomme', marks: [{ type: 'strong' }] },
                {
                  type: 'text',
                  text: ' (solgte) skal IKKE vises på person-diagrammet — samme regel som på virksomheds-diagrammet.',
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
                { type: 'text', text: 'Ejendomme-toggle-knappen ', marks: [] },
                { type: 'text', text: 'skal være DEFAULT DEAKTIVERET', marks: [{ type: 'strong' }] },
                {
                  type: 'text',
                  text: ' — diagrammet åbner uden ejendomme. Bruger kan aktivere toggle for at se ejendomme. Det forhindrer at person-diagrammet bliver overfyldt.',
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
                { type: 'text', text: 'Overflow-bokse ', marks: [] },
                { type: 'text', text: '("+N ejendomme")', marks: [{ type: 'code' }] },
                {
                  type: 'text',
                  text: ' skal kunne udvides — klik på boksen viser indhold inline som på virksomheds-diagrammet (jf. BIZZ-568 om bottom-row placement + udvidelse).',
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
                  text: 'Layout-regler, zoom-defaults, centrering, pan/træk, Udvid-knappen — alt skal opføre sig identisk med virksomheds-diagrammet. Én delt render-komponent bør håndtere begge diagram-typer, kun med forskellig input-data.',
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
                  text: 'Refactor: fælles DiagramRenderer-komponent med props til valgfri features (showProperties toggle default-state, personRoles-sektion on/off, overflow-behavior).',
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
                  text: 'Filter historiske ejendomme i data-layer (aktiv === true) før diagrammet bygges, ikke i UI.',
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
                  text: 'Default-state for ejendomme-toggle på person-siden: false. På virksomheds-siden: true (uændret).',
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
                  text: 'Person-diagram åbner uden ejendomme-noder synlige. Ejendomme-toggle knap er synlig men inaktiv default.',
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
                  text: 'Når ejendomme-toggle aktiveres: kun AKTIVE ejendomme vises. Solgte/historiske ejendomme aldrig synlige på diagrammet.',
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
                  text: 'Overflow-bokse ("+N ejendomme") kan klikkes og udvider inline — samme som virksomheds-diagrammet.',
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
                  text: 'Personrelations-info (virksomheder + roller) bevares — ingen regression på den unikke person-data.',
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
                  text: 'Zoom, pan, centrer, reset-knapper fungerer identisk på begge diagram-typer.',
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
                  text: 'Relaterer: BIZZ-568 (overflow bottom-row), BIZZ-549 (diagram udvid-knap), BIZZ-546 (personligt ejede ejendomme vises ikke), BIZZ-552 (diagram-centrering).',
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
    summary: 'Diagram: align person-diagram med virksomheds-diagram (skjul historik, ejendomme-toggle default off, overflow-udvid)',
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
