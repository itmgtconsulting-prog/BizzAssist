#!/usr/bin/env node
/**
 * Finaliserer status på verificerede tickets:
 *   - BIZZ-595: transition In Review → To Do/In Progress (bug ikke fixet på test)
 *   - Andre In Review tickets forbliver — de har verifikations-kommentarer og
 *     venter enten på manuel browser-test eller code-review.
 *
 * Printer samlet final-oversigt bagefter.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}

// ── BIZZ-595 tilbage til "To Do" eller "In Progress" ───────────────────────
console.log('═══ Transition BIZZ-595 tilbage (bug ikke fixet på test) ═══');
const tr = await req('GET', '/rest/api/3/issue/BIZZ-595/transitions');
const transitions = JSON.parse(tr.body).transitions ?? [];
console.log(`Tilgængelige transitions: ${transitions.map(t => `${t.id}:${t.name}`).join(', ')}`);

const target =
  transitions.find(t => /^to\s*do$/i.test(t.name)) ??
  transitions.find(t => /^in\s*progress$/i.test(t.name)) ??
  transitions.find(t => /reopen/i.test(t.name)) ??
  transitions.find(t => /backlog/i.test(t.name));

if (target) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-595/transitions', { transition: { id: target.id } });
  console.log(r.status === 204 ? `✅ BIZZ-595 → ${target.name}` : `⚠️  Transition fejl (${r.status}): ${r.body.slice(0, 200)}`);
} else {
  console.log('⚠️  Ingen passende transition fundet. Ticket forbliver i "In Review".');
}

// ── Samlet slutoversigt af alle 12 tickets der var In Review ved start ────
console.log('\n═══ FINAL STATUS — alle 12 oprindelige In Review tickets ═══');
const keys = ['BIZZ-604', 'BIZZ-606', 'BIZZ-609', 'BIZZ-610', 'BIZZ-595', 'BIZZ-605', 'BIZZ-585', 'BIZZ-597', 'BIZZ-598', 'BIZZ-599', 'BIZZ-600', 'BIZZ-601'];

for (const key of keys) {
  const res = await req('GET', `/rest/api/3/issue/${key}?fields=summary,status,priority`);
  const d = JSON.parse(res.body);
  const s = d.fields.status.name;
  const emoji = s === 'Done' ? '✅' : s === 'To Do' ? '🔄' : s === 'In Progress' ? '🚧' : '📝';
  console.log(`  ${emoji} ${key} [${s}]  ${d.fields.summary.slice(0, 70)}`);
}
