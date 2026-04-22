#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const jql = 'project=BIZZ AND status="To Do" AND issuetype != Epic ORDER BY priority DESC, created ASC';
const r = await req('POST', `/rest/api/3/search/jql`, { jql, fields: ['summary','priority','created','labels'], maxResults: 100 });
const d = JSON.parse(r.body);
if (!d.issues) { console.log('raw:', r.status, r.body.slice(0, 500)); process.exit(1); }
console.log('Total:', d.issues.length);
for (const i of d.issues) {
  console.log(`  ${i.key}  [${i.fields.priority?.name ?? '?'}]  ${i.fields.summary}`);
}
