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
function extractText(doc) {
  if (!doc) return '';
  let out = '';
  const walk = (n) => {
    if (!n) return;
    if (typeof n === 'string') { out += n; return; }
    if (n.text) out += n.text;
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' || n.type === 'codeBlock') out += '\n';
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return out.trim();
}
const keys = process.argv.slice(2);
for (const key of keys) {
  const r = await req('GET', `/rest/api/3/issue/${key}?fields=summary,description,status,priority,labels`);
  const d = JSON.parse(r.body);
  console.log(`\n══════════ ${key} [${d.fields.status?.name}] [${d.fields.priority?.name}] ═══════════`);
  console.log(`${d.fields.summary}\n`);
  console.log('DESCRIPTION:\n' + extractText(d.fields.description) + '\n');
  const cr = await req('GET', `/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=5`);
  const cd = JSON.parse(cr.body);
  console.log(`--- Last ${(cd.comments||[]).slice(0,3).length} comments ---`);
  for (const c of (cd.comments || []).slice(0, 3).reverse()) {
    console.log(`\n[${c.created?.slice(0,16)}] ${c.author?.displayName}`);
    console.log(extractText(c.body));
  }
}
