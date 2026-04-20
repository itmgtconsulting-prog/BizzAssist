#!/usr/bin/env node
/**
 * Transition a list of JIRA tickets to Done.
 * Usage: node scripts/transition-to-done.mjs BIZZ-491 BIZZ-492 ...
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL || 'itmgtconsulting@gmail.com';
const TOKEN = process.env.JIRA_API_TOKEN;
const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

if (!TOKEN) {
  console.error('JIRA_API_TOKEN missing');
  process.exit(1);
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const keys = process.argv.slice(2);
if (!keys.length) {
  console.error('No ticket keys provided');
  process.exit(1);
}

for (const key of keys) {
  const transitions = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  if (transitions.status !== 200) {
    console.log(
      `${key}: FAILED to fetch transitions (${transitions.status}) ${transitions.body.slice(0, 200)}`
    );
    continue;
  }
  const list = JSON.parse(transitions.body).transitions || [];
  const done = list.find((t) => /^done$/i.test(t.name) || t.to?.name?.toLowerCase() === 'done');
  if (!done) {
    console.log(
      `${key}: no Done transition available. Options: ${list.map((t) => t.name).join(', ')}`
    );
    continue;
  }
  const res = await req('POST', `/rest/api/3/issue/${key}/transitions`, {
    transition: { id: done.id },
  });
  console.log(`${key}: transition ${done.name} (id=${done.id}) → ${res.status}`);
}
