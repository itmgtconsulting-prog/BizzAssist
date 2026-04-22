#!/usr/bin/env node
/**
 * List all domain-feature-related tickets regardless of status.
 * BIZZ-698 is the epic; children span ~BIZZ-699 through ~BIZZ-737.
 */
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

// Search by epic link and/or domain labels
const jqls = [
  { label: 'Epic BIZZ-698 children', jql: '"Epic Link" = BIZZ-698 ORDER BY key ASC' },
  { label: 'Summary matches "domain"', jql: 'project = BIZZ AND summary ~ "domain" AND issuetype != Epic ORDER BY key ASC' },
  { label: 'Summary matches "Domain:"', jql: 'project = BIZZ AND summary ~ "\\"Domain:\\"" ORDER BY key ASC' },
];

const seen = new Set();
for (const { label, jql } of jqls) {
  const r = await req('POST', `/rest/api/3/search/jql`, { jql, fields: ['summary', 'status', 'priority', 'issuetype'], maxResults: 200 });
  const d = JSON.parse(r.body);
  console.log(`\n═══ ${label} (${(d.issues || []).length}) ═══`);
  for (const i of d.issues || []) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    const status = i.fields.status?.name.padEnd(14);
    const prio = (i.fields.priority?.name ?? '-').padEnd(7);
    const type = i.fields.issuetype?.name.padEnd(7);
    console.log(`  ${i.key.padEnd(10)} [${status}] [${prio}] [${type}] ${i.fields.summary}`);
  }
}
console.log(`\n═══ Unique tickets: ${seen.size} ═══`);
