#!/usr/bin/env node
/**
 * Creates JIRA ticket: Ejerskabsdiagram er ikke midterstillet i tab-panelet.
 *
 * Observeret 2026-04-20 på test.bizzassist.dk:
 * Ejendom dd4a90de-b126-4438-824f-3677efab2bd0 (Thorvald Bindesbølls Plads 18,
 * BFE 100165718). På Ejerskab-tab ligger ejerskabsdiagrammet med nodes
 * venstrestillet i stedet for centreret.
 *
 * Run: node scripts/create-ejerskabsdiagram-centering-ticket.mjs
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
const PROJECT_KEY = 'BIZZ';

if (!EMAIL || !TOKEN) {
  console.error('Missing JIRA_EMAIL or JIRA_API_TOKEN in .env.local');
  process.exit(1);
}

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

const p = (...nodes) => ({
  type: 'paragraph',
  content: nodes.map((n) => (typeof n === 'string' ? { type: 'text', text: n } : n)),
});
const h = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const bullets = (items) => ({
  type: 'bulletList',
  content: items.map((item) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
  })),
});

const description = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'Baggrund'),
    p(
      'Rapporteret 2026-04-20 af bruger via screenshot fra test.bizzassist.dk (desktop-visning). Ejerskabsdiagrammet på en ejendoms Ejerskab-tab rendrer nodes venstrestillet i stedet for at være centreret i det tilgængelige diagram-panel. Resulterer i stor tom plads på højre side og ser visuelt unfinished ud.'
    ),
    h(2, 'Observeret på'),
    bullets([
      'URL: https://test.bizzassist.dk/dashboard/ejendomme/dd4a90de-b126-4438-824f-3677efab2bd0',
      'Ejendom: Thorvald Bindesbølls Plads 18, 3. th, 1799 København V',
      'BFE: 100165718',
      'ESR: 101-39396',
      'Ejendomstype: Ejerlejlighed',
      'Aktiv tab: Ejerskab',
      'Ejer: Jakob Juul Rasmussen (100%)',
      'Diagram-zoom: 100%',
      'Viewport: desktop (bred)',
    ]),
    h(2, 'Symptom'),
    p(
      'To nodes vises: person-node (Jakob Juul Rasmussen) øverst og property-node (Thorvald Bindesbølls Plads 18) nedenunder, forbundet med "100%"-kant. Begge nodes ligger ~10-15% fra venstre kant af diagram-panelet. Den højre halvdel af panelet er helt tom.'
    ),
    p(
      'Forventet: nodes skal være vertikalt center-aligned (x ≈ viewport-midten). På små diagrammer (fx kun 2 nodes) bør D3-simulering eller initial-positionering placere dem i midten af SVG-viewBox.'
    ),
    h(2, 'Sandsynlig årsag'),
    bullets([
      'buildDiagramGraph / DiagramForce initial node-position sætter x=0 eller x=NODE_W/2 frem for viewport-midten',
      'forceCenter(viewBoxWidth/2, viewBoxHeight/2) er enten ikke anvendt eller ikke re-kørt når panel resizes',
      'Hvis diagrammet er på Ejerskab-tab og tabben ikke er synlig ved initial mount, kan SVG-containerbredden være 0 → center beregnes forkert og korrigeres ikke ved tab-switch',
      'Centrer-knappen findes (visible i screenshot) men auto-center ved mount/tab-skift mangler',
    ]),
    h(2, 'Reproduktion'),
    bullets([
      'Login på test.bizzassist.dk',
      'Naviger til URL ovenfor (eller søg "Thorvald Bindesbølls Plads 18")',
      'Klik Ejerskab-tab',
      'Observer at de 2 nodes i ejerskabsdiagrammet er venstrestillet',
      'Klik "Centrer"-knappen → diagrammet centres korrekt (workaround)',
    ]),
    h(2, 'Foreslået fix'),
    bullets([
      'I DiagramForce.tsx: kald centerGraph() / forceCenter() i useEffect når graph.nodes ændres ELLER når panelet bliver synligt første gang',
      'Brug ResizeObserver på SVG-container så re-center ved resize',
      'Alternativt: sæt initial pos for hver node ud fra viewBox-midten før simulering starter',
      'Fix skal ikke overskrive bruger-manuelle drag-positioner (beholdt efter første centrering)',
    ]),
    h(2, 'Acceptance criteria'),
    bullets([
      'Ejerskabsdiagram på ejendoms-detaljeside er visuelt centreret ved initial load',
      'Diagram forbliver centreret ved tab-skift (Ejerskab → anden tab → Ejerskab)',
      'Bruger-manuelle drag-positioner bevares (auto-center kun ved første visning eller explicit klik på Centrer)',
      'Virker både for 2-node-diagrammer og større ejerskabs-kæder',
      'Ingen regression på virksomhedsdiagrammet',
    ]),
    h(2, 'Relaterede tickets'),
    bullets([
      'BIZZ-446 — tidligere fit+center trigger på 100%-knap',
      'BIZZ-597 — person/virksomhed diagram alignment',
    ]),
  ],
};

const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary: 'Ejerskabsdiagram: nodes venstrestillet i stedet for centreret (ejendoms-detaljeside)',
    description,
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    labels: ['diagram', 'ui', 'ejerskab', 'ejendom'],
  },
};

const created = await req('POST', '/rest/api/3/issue', payload);
if (created.status !== 201) {
  console.error('Create failed:', created.status, created.body);
  process.exit(1);
}
const key = JSON.parse(created.body).key;
console.log(`Created: ${key}`);
console.log(`\nDone: https://${HOST}/browse/${key}`);
