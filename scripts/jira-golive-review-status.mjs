#!/usr/bin/env node
/**
 * Sammenfatter status på go-live / security / code-review tickets:
 *   - 2026-04-20 code review batch (BIZZ-598 til 603)
 *   - 2026-04-16 go-live readiness epic (tidligere batch)
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

function r(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const q = https.request(
      {
        hostname: HOST,
        path: p,
        method: m,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
        },
      },
      (x) => {
        let y = '';
        x.on('data', (c) => (y += c));
        x.on('end', () => res({ status: x.statusCode, body: y }));
      }
    );
    q.on('error', rej);
    if (d) q.write(d);
    q.end();
  });
}

async function search(jql, label) {
  const res = await r('POST', '/rest/api/3/search/jql', {
    jql,
    fields: ['summary', 'status', 'priority', 'labels', 'created'],
    maxResults: 50,
  });
  const d = JSON.parse(res.body);
  const byStatus = new Map();
  for (const i of d.issues || []) {
    const s = i.fields.status.name;
    if (!byStatus.has(s)) byStatus.set(s, []);
    byStatus.get(s).push(i);
  }
  console.log(`\n═══ ${label} — ${d.total} tickets ═══`);
  for (const [status, items] of byStatus) {
    console.log(`\n  [${status}] — ${items.length} tickets`);
    for (const i of items) {
      const pri = i.fields.priority?.name || '?';
      console.log(`    ${i.key} (${pri}) ${i.fields.summary.slice(0, 85)}`);
    }
  }
}

// 1) Today's code review batch
await search(
  'project = BIZZ AND key in (BIZZ-598, BIZZ-599, BIZZ-600, BIZZ-601, BIZZ-602, BIZZ-603)',
  '2026-04-20 Kodekvalitet + Test coverage review'
);

// 2) Go-live readiness epic from 2026-04-16 (P0/P1 security, GDPR, ISO, OPS)
await search(
  'project = BIZZ AND (labels in (p0, p1, p2) OR summary ~ "Go-live readiness") AND created >= "2026-04-15"',
  '2026-04-16 Go-Live Readiness Epic (security/GDPR/ISO/ops)'
);

// 3) All still-open High/P0/P1 tickets relevant to prod launch
await search(
  'project = BIZZ AND priority in (Highest, High) AND status != Done AND (labels in (security, iso27001, gdpr, compliance, p0, p1) OR summary ~ "Pre-launch" OR summary ~ "go-live")',
  'Stadig åbne kritiske prod-launch tickets'
);
