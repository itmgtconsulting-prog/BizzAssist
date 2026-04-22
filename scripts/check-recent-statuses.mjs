#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p) {
  return new Promise((res, rej) => {
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } },
      (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); r.end();
  });
}
for (const key of ['BIZZ-685', 'BIZZ-693', 'BIZZ-716', 'BIZZ-720', 'BIZZ-724', 'BIZZ-696']) {
  const r = await req('GET', `/rest/api/3/issue/${key}?fields=status,summary`);
  const d = JSON.parse(r.body);
  console.log(`${key.padEnd(10)} [${(d.fields?.status?.name ?? '?').padEnd(14)}] ${d.fields?.summary ?? ''}`);
}
