#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(p) { return new Promise((res, rej) => { const r = https.request({ hostname: HOST, path: p, method: 'GET', headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } }, (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res({ status: x.statusCode, body: y })); }); r.on('error', rej); r.end(); }); }
function adf(node, out = []) {
  if (!node) return out;
  if (node.type === 'text') out.push(node.text);
  if (node.type === 'heading') out.push(`\n## ${node.content?.map(c => c.text || '').join('')}\n`);
  if (node.content) node.content.forEach(c => adf(c, out));
  if (node.type === 'listItem') out.push('\n• ');
  if (node.type === 'paragraph') out.push('\n');
  return out;
}
for (const key of ['BIZZ-732', 'BIZZ-724']) {
  const r = await req(`/rest/api/3/issue/${key}?fields=summary,description,comment`);
  const j = JSON.parse(r.body);
  console.log(`\n${'═'.repeat(70)}\n${key}: ${j.fields.summary}\n${'═'.repeat(70)}`);
  const text = adf(j.fields.description).join('').trim();
  console.log(text.slice(0, 1200));
  const comments = j.fields.comment?.comments || [];
  console.log(`\n--- ${comments.length} kommentarer (seneste 2) ---`);
  for (const c of comments.slice(-2)) {
    console.log(`\n[${c.updated} ${c.author?.displayName}]`);
    console.log(adf(c.body).join('').trim().slice(0, 900));
  }
}
