#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
    );
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}
const body = {
  body: {
    type: 'doc', version: 1, content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Korrektion — genåbner pga. regressioner' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'Min tidligere "Playwright-verifikation PASS" testede kun de direkte API-endpoints (/api/cvr-public, /api/cvr/[cvr], /api/ejendomme-by-owner, /api/ejerskab) og virksomhedsside-oversigten — ikke de komplekse tabs (Diagram, Virksomheder, Personer, Kronologi). Jakob har efterfølgende identificeret 6 UI-regressioner (BIZZ-681-686) og revertet fdfc6d8 via 7a79eff. Reverteringen rammer præcis den DB-first-stien jeg troede var verificeret.' }
      ] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'Læring: UI-level ejerskabsdiagrammer + virksomheds-hierarki kræver enrichment (virksomhedsnavn via cvr-lookup, pvoplys-felter, person-detaljer) som ejf_ejerskab-tabellen ikke indeholder. Simpel API-shape-check er ikke tilstrækkelig verifikation for denne type refactor.' }
      ] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Genåbner som To Do. Ticket kan lukkes igen når DB-first-versionen også enrichter til fuld parity med live Datafordeler-respons.', marks: [{ type: 'strong' }] }] }
    ]
  }
};
const c = await req('POST', '/rest/api/3/issue/BIZZ-680/comment', body);
console.log(c.status === 201 ? '✅ comment' : `❌ ${c.status}`);
const r = await req('POST', '/rest/api/3/issue/BIZZ-680/transitions', { transition: { id: '11' } });
console.log(r.status === 204 ? '✅ BIZZ-680 → To Do' : `⚠️ ${r.status} ${r.body}`);
