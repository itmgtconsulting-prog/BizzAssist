#!/usr/bin/env node
/**
 * Creates JIRA ticket for EJF bulk-data seed på prod Supabase.
 *
 * Context: BIZZ-534 er merged til main og deployed. Preview (test.bizzassist.dk)
 * er fuldt seedet (~7.6M records). Prod (bizzassist.dk) har samme kode + schema,
 * men ejf_ejerskab-tabellen er tom — cron'en kører dagligt 04:00 UTC og vil over
 * tid fylde den op, men for at feature'en virker fra dag 1 skal vi seede manuelt.
 *
 * On hold fordi: Preview-seed er nok til verificering + go-live kan ske når
 * prod-cron naturligt har kørt nogle dage, eller hvis brug-case kræver
 * øjeblikkelig adgang.
 *
 * Run: node scripts/create-prod-ejf-seed-ticket.mjs
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

// ─── ADF document builders ────────────────────────────────────────────────
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
const code = (text, lang = 'bash') => ({
  type: 'codeBlock',
  attrs: { language: lang },
  content: [{ type: 'text', text }],
});

// ─── Ticket body ──────────────────────────────────────────────────────────
const description = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'Baggrund'),
    p(
      'BIZZ-534 (EJF bulk-ingestion) er merged til main og deployed. Feature virker end-to-end på ',
      { type: 'text', text: 'test.bizzassist.dk', marks: [{ type: 'strong' }] },
      ' med fuldt seedet database (~7.6M records, 6.6M personer, 2.56M unikke BFEs). Verificeret med Jakob Juul Rasmussen: alle 9 gældende personligt ejede ejendomme (inkl. Søbyvej 11 med 50% ejerskab) vises korrekt på virksomhedsdiagrammet når man klikker "Udvid" på hans person-node.'
    ),
    p(
      'Prod (',
      { type: 'text', text: 'bizzassist.dk', marks: [{ type: 'strong' }] },
      ') har samme kode og schema (migrations 046+047+048 kørt), men ',
      { type: 'text', text: 'ejf_ejerskab-tabellen er tom', marks: [{ type: 'strong' }] },
      '. Vercel-cron kører dagligt kl. 04:00 UTC og vil gradvis fylde den op, men ved nuværende tempo (~90k records/kørsel) tager det ~70 dage før fuld coverage.'
    ),
    h(2, 'Opgave'),
    p(
      'Seed ejf_ejerskab-tabellen på prod Supabase ved at trigge /api/cron/ingest-ejf-bulk ~75 gange i sekventiel loop. Hver kørsel tager ~5 min og processer 80-110k records.'
    ),
    h(3, 'Fremgangsmåde'),
    bullets([
      'Hent CRON_SECRET fra Vercel prod-env (samme værdi som preview i dette tilfælde)',
      'Kør seed-loop script (samme som brugt på preview — /tmp/seed-loop.sh)',
      'Total kørselstid: ~6-7 timer sekventielt',
      'Kan parallelles ikke (cursor-baseret pagination)',
      'Verificer med SQL-query: SELECT count(*) FROM ejf_ejerskab',
    ]),
    h(3, 'Kommando til prod-seed'),
    code(
      `# Få CRON_SECRET fra Vercel prod
CRON_SECRET=$(curl -s -H "Authorization: Bearer $VERCEL_API_TOKEN" \\
  "https://api.vercel.com/v9/projects/$VERCEL_PROJECT_ID/env?teamId=$VERCEL_TEAM_ID" \\
  | jq -r '.envs[] | select(.key=="CRON_SECRET" and (.target | contains(["production"]))) | .id' \\
  | head -1)

# Kør loop (tilpasset fra /tmp/seed-loop.sh)
for i in $(seq 1 100); do
  echo "[$(date +%H:%M:%S)] kørsel $i"
  RES=$(curl -s -m 320 -H "Authorization: Bearer $CRON_SECRET" \\
    "https://bizzassist.dk/api/cron/ingest-ejf-bulk")
  echo "  $RES"
  if echo "$RES" | grep -q '"complete":true'; then
    echo "SEED KOMPLET efter $i kørsler"; break
  fi
  sleep 5
done`
    ),
    h(2, 'Acceptance criteria'),
    bullets([
      'public.ejf_ejerskab på prod indeholder 7M+ records',
      'public.ejf_ingest_runs har en kørsel med complete=true',
      'Person-expand på Jakob Juul Rasmussen på bizzassist.dk viser 9 ejendomme (samme som test.bizzassist.dk)',
      'Ingen rækker i ejf_ejerskab på prod er ældre end 24 timer (hvis cron kører)',
    ]),
    h(2, 'Hvorfor On Hold'),
    p('Preview er fuldt verificeret og feature fungerer korrekt. Prod kan vente til:'),
    bullets([
      'Vi vil demonstrere feature live på bizzassist.dk (fx til kunder/investorer)',
      'Vi har brugere der eksplicit spørger efter personligt ejede ejendomme på prod-diagrammer',
      'Daglige cron har kørt længe nok til at have ~naturlig seed (~70 dage)',
    ]),
    p(
      'Indtil da vil prod-cron gradvist fylde tabellen op via daglige kørsler. Ingen funktionalitet er broken — feature fungerer bare endnu ikke fuldt på prod før data er seedet.'
    ),
    h(2, 'Referencer'),
    bullets([
      'BIZZ-534 — forudsætning (merged)',
      'Migration 046 (ejf_ejerskab schema)',
      'Migration 047 (ejer_ejf_id TEXT)',
      'Migration 048 (ix_ejf_person_navn_exact)',
      '/api/cron/ingest-ejf-bulk — cron-route',
      'Preview-seed dokumentation: see session notes 2026-04-19',
    ]),
  ],
};

// ─── Create ticket ────────────────────────────────────────────────────────
const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary: 'EJF bulk-data seed på prod (bizzassist.dk)',
    description,
    issuetype: { name: 'Task' },
    priority: { name: 'Low' },
    labels: ['ejf', 'bulk-ingestion', 'prod', 'opfølgning-bizz534'],
  },
};

const created = await req('POST', '/rest/api/3/issue', payload);
if (created.status !== 201) {
  console.error('Create failed:', created.status, created.body);
  process.exit(1);
}
const key = JSON.parse(created.body).key;
console.log(`Created: ${key}`);

// ─── Transition to On Hold ────────────────────────────────────────────────
const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
const transitions = JSON.parse(tr.body).transitions || [];
console.log('Available transitions:', transitions.map((t) => t.name).join(', '));

const hold = transitions.find(
  (t) => /blocked|on hold|hold/i.test(t.name) || /blocked|on hold|hold/i.test(t.to?.name || '')
);

if (!hold) {
  console.log('No Blocked/On Hold transition available — leaving in default status');
} else {
  const res = await req('POST', `/rest/api/3/issue/${key}/transitions`, {
    transition: { id: hold.id },
  });
  console.log(`Transitioned to ${hold.name}: HTTP ${res.status}`);

  // Add comment
  const commentBody = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '⏸ On hold: ', marks: [{ type: 'strong' }] },
            {
              type: 'text',
              text: 'Feature er fuldt verificeret på test.bizzassist.dk med 7.6M records. Prod-cron kører dagligt og vil gradvis seede. Tag denne op når vi skal demonstrere live eller har konkret brug-case.',
            },
          ],
        },
      ],
    },
  };
  await req('POST', `/rest/api/3/issue/${key}/comment`, commentBody);
  console.log('Added on-hold comment');
}

console.log(`\nDone: https://${HOST}/browse/${key}`);
