#!/usr/bin/env node
/** Quick status check — To Do + In Progress + In Review tickets. */
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

const statuses = ['To Do', 'In Progress', 'In Review'];
for (const status of statuses) {
  const jql = `project=BIZZ AND status="${status}" AND issuetype != Epic ORDER BY priority DESC, updated DESC`;
  const r = await req('POST', `/rest/api/3/search/jql`, { jql, fields: ['summary', 'priority', 'updated'], maxResults: 50 });
  const d = JSON.parse(r.body);
  const issues = d.issues || [];
  console.log(`\n═══ ${status} (${issues.length}) ═══`);
  for (const i of issues) {
    const prio = (i.fields.priority?.name ?? '-').padEnd(7);
    const upd = i.fields.updated?.slice(0, 16) ?? '';
    console.log(`  ${i.key.padEnd(10)} [${prio}] ${upd}  ${i.fields.summary}`);
  }
}
