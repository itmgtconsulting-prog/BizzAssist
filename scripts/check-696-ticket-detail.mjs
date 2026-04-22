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
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
    );
    r.on('error', rej);
    r.end();
  });
}

// Flattener ADF til plain-text for at vise længde + struktur
function adfToText(node, out = []) {
  if (!node) return out;
  if (node.type === 'text') out.push(node.text);
  if (node.type === 'heading') out.push(`\n## ${node.content?.map(c => c.text || '').join('')}`);
  if (node.content) node.content.forEach(c => adfToText(c, out));
  if (node.type === 'listItem') out.push('\n  • ');
  if (node.type === 'paragraph') out.push('\n');
  if (node.type === 'codeBlock') out.push('\n[codeblock]\n');
  return out;
}

const tickets = ['BIZZ-696', 'BIZZ-697', 'BIZZ-698', 'BIZZ-699', 'BIZZ-715', 'BIZZ-717', 'BIZZ-720'];
for (const key of tickets) {
  const r = await req('GET', `/rest/api/3/issue/${key}?fields=summary,description,priority,labels`);
  const j = JSON.parse(r.body);
  const text = adfToText(j.fields.description).join('').trim();
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${key}  [${j.fields.priority?.name}]  ${j.fields.summary}`);
  console.log(`labels: ${j.fields.labels.join(', ')}`);
  console.log(`desc length: ${text.length} chars,  sections: ${(text.match(/##/g) || []).length}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(text.slice(0, 1200));
  if (text.length > 1200) console.log(`\n... (${text.length - 1200} tegn mere)`);
}
