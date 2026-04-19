#!/usr/bin/env node
/**
 * Adds a comment to EJF-related tickets confirming that full EJF access is
 * now granted via Datafordeler (REST, Filudtræk, Hændelser) — so these
 * tickets should NOT be marked Blocked.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = 'bizzassist.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
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

const TICKETS = {
  'BIZZ-480':
    'EJF_Handelsoplysninger-udvidelser — fuld EJF-adgang bekræftet 2026-04-19 (REST-endpoint tilgængeligt via confluence.sdfi.dk/EJF). Kan implementeres direkte: tilføj felter skødetekst, bygninger, afståelsesdato til /api/ejerskab-opslag.',
  'BIZZ-481':
    'EJF_Ejerskifte-udvidelser — fuld EJF-adgang bekræftet 2026-04-19. Kan implementeres direkte: udvid EJF_Ejerskifte-opslag med betinget/frist/anmeldelse/forretningshændelse-felter via REST.',
  'BIZZ-534':
    '[P1] EJF + CVR bulk-ingestion — fuld adgang bekræftet 2026-04-19. Filudtræk (EJF) tilgængelig via Datafordeler selvbetjening. Næste skridt: hent EJF_BULK_DUMP_URL fra selvbetjening, whitelist dataudtraek.datafordeler.dk i proxy-server, sæt env-var, kør /api/cron/ingest-ejf-bulk (Mode A). Unblocker person→ejendomme lookup.',
  'BIZZ-576':
    'EJF drill-down fra hovedejendom-BFE til specifik ejerlejlighed-BFE — fuld EJF REST-adgang bekræftet 2026-04-19. Kan nu implementere ejerlejlighed-opslag under samme hovednoteringsnummer via EJF REST (ikke kun custom-endpoint). Unblocker BIZZ-577 (UI).',
};

const DOC_URL = 'https://confluence.sdfi.dk/pages/viewpage.action?pageId=13664923';

for (const [key, reason] of Object.entries(TICKETS)) {
  const comment = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '🔓 Ikke længere Blocked ',
              marks: [{ type: 'strong' }],
            },
            { type: 'text', text: '— fuld EJF-adgang bekræftet.' },
          ],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: reason }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Reference: ' },
            {
              type: 'text',
              text: DOC_URL,
              marks: [{ type: 'link', attrs: { href: DOC_URL } }],
            },
          ],
        },
      ],
    },
  };
  const res = await req('POST', `/rest/api/3/issue/${key}/comment`, comment);
  console.log(`${key}: comment HTTP ${res.status}`);
}
