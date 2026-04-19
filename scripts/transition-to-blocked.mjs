#!/usr/bin/env node
/**
 * Moves blocked tickets to the Blocked status.
 *
 * Prerequisite: "Blocked" must be configured as a column on the SCRUM board
 * in Jira UI so a transition to it exists on BIZZ tickets.
 *
 * Usage: node scripts/transition-to-blocked.mjs [TICKET-KEY ...]
 * Default set = the 8 tickets blocked by external data constraints.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

// EJF-tickets (480, 481, 534, 576) er FJERNET fra Blocked-listen 2026-04-19
// efter bekræftet fuld EJF-adgang (REST + Filudtræk + Hændelser via selvbetjening.datafordeler.dk).
// BIZZ-557 er allerede lukket (split i 576+577).
const DEFAULT_KEYS = [
  'BIZZ-501', // MAT geometri
  'BIZZ-485', // BBR materiale-detaljer
  'BIZZ-484', // BBR_TekniskAnlaeg
  'BIZZ-560', // CVR XBRL noter
  'BIZZ-483', // PV-detaljeside
];

const BLOCKER_REASONS = {
  'BIZZ-501': 'MAT direkte geometri — probing viser at Datafordeler MAT WFS kræver polygon-parsing der ikke matcher DAWA-fallback; skal have adgang til nyt matrikel-format først.',
  'BIZZ-485': 'BBR materiale-detaljer — probing af BBR_Bygning GraphQL schema viser at tagkonstruktion/ydervæg-lag/isolering ikke eksponeres som separate felter, kun aggregeret byg033Tagmateriale.',
  'BIZZ-484': 'BBR_TekniskAnlaeg — probing viser at Datafordeler BBR v2 GraphQL kun eksponerer reference-felter (husnummer/bygning/grund/enhed/jordstykke) + metadata. Data-felter (anlægstype/fabrikat/ydelse) mangler. Kræver REST API-integration.',
  'BIZZ-560': 'CVR XBRL noter — probing viser at noter-sektionen i XBRL-regnskaber ikke parses fra CVR regnskabs-API. Kræver separat XBRL parser-integration.',
  'BIZZ-483': 'PV-detaljeside for fiktivtPVnummer — blokeret af at dødsbo/fond/udenlandske ejere ikke har stabilt CVR/enhedsNummer, kræver ny datamodel for ikke-registrerede ejere.',
};

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

/**
 * Adds a comment explaining WHY the ticket is blocked.
 */
async function addBlockerComment(key, reason) {
  const body = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '🚫 Blokeret: ', marks: [{ type: 'strong' }] },
            { type: 'text', text: reason },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Markeret Blocked via scripts/transition-to-blocked.mjs — tages op igen når blokeringen er løst.',
              marks: [{ type: 'em' }],
            },
          ],
        },
      ],
    },
  };
  const r = await req('POST', `/rest/api/3/issue/${key}/comment`, body);
  return r.status === 201;
}

const keys = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_KEYS;

for (const key of keys) {
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  if (tr.status !== 200) {
    console.log(`${key}: FAILED to fetch transitions (${tr.status})`);
    continue;
  }
  const list = JSON.parse(tr.body).transitions || [];
  const blocked = list.find(
    (t) => /^blocked$/i.test(t.name) || /^blocked$/i.test(t.to?.name || '')
  );
  if (!blocked) {
    console.log(
      `${key}: Blocked transition NOT AVAILABLE. Options: ${list.map((t) => t.name).join(', ')}`
    );
    continue;
  }
  const res = await req('POST', `/rest/api/3/issue/${key}/transitions`, {
    transition: { id: blocked.id },
  });
  const reason = BLOCKER_REASONS[key] ?? 'Blokeret — se historik for detaljer.';
  const commentOk = await addBlockerComment(key, reason);
  console.log(
    `${key}: transition → Blocked (id=${blocked.id}) HTTP ${res.status}${commentOk ? ' + comment' : ''}`
  );
}
