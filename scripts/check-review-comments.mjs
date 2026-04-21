#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString(
  'base64'
);
function req(p) {
  return new Promise((res, rej) => {
    https
      .request(
        {
          hostname: HOST,
          path: p,
          method: 'GET',
          headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
        },
        (x) => {
          let y = '';
          x.on('data', (c) => (y += c));
          x.on('end', () => res({ status: x.statusCode, body: y }));
        }
      )
      .on('error', rej)
      .end();
  });
}
function walk(n) {
  if (!n) return '';
  if (n.text) return n.text;
  if (n.content) return n.content.map(walk).join('');
  return '';
}
const keys = process.argv.slice(2);
for (const k of keys) {
  console.log('\n===', k, '===');
  const r = await req(`/rest/api/3/issue/${k}/comment?orderBy=-created&maxResults=3`);
  const j = JSON.parse(r.body);
  (j.comments || []).slice(-3).forEach((c) => {
    console.log(`• ${c.author.displayName} ${c.created.slice(0, 16)}`);
    console.log('  ' + walk(c.body).slice(0, 400).replace(/\s+/g, ' '));
  });
}
