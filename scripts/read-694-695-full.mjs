#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(p) { return new Promise((res, rej) => { const r = https.request({ hostname: HOST, path: p, method: 'GET', headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } }, (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res({ status: x.statusCode, body: y })); }); r.on('error', rej); r.end(); }); }
function adfToText(node, out = []) {
  if (!node) return out;
  if (node.type === 'text') out.push(node.text);
  if (node.type === 'heading') out.push(`\n## ${node.content?.map(c => c.text || '').join('')}\n`);
  if (node.type === 'codeBlock') out.push('\n```\n');
  if (node.content) node.content.forEach(c => adfToText(c, out));
  if (node.type === 'codeBlock') out.push('\n```\n');
  if (node.type === 'listItem') out.push('\n• ');
  if (node.type === 'paragraph') out.push('\n');
  return out;
}
for (const key of ['BIZZ-694', 'BIZZ-695']) {
  const r = await req(`/rest/api/3/issue/${key}?fields=summary,description,comment,labels`);
  const j = JSON.parse(r.body);
  const text = adfToText(j.fields.description).join('').trim();
  console.log(`\n${'═'.repeat(70)}\n${key}: ${j.fields.summary}\nlabels: ${j.fields.labels.join(', ')}\n${'═'.repeat(70)}`);
  console.log(text);
  console.log(`\n--- ${j.fields.comment.comments.length} comments ---`);
  for (const c of j.fields.comment.comments.slice(-3)) {
    console.log(`\n[${c.updated} by ${c.author?.displayName}]`);
    console.log(adfToText(c.body).join('').trim().slice(0, 800));
  }
}
