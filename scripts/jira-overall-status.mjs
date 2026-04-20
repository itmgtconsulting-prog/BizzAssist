import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function r(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const q = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); });
    q.on('error', rej); if (d) q.write(d); q.end();
  });
}

async function search(jql, label) {
  const res = await r('POST', '/rest/api/3/search/jql', {
    jql, fields: ['summary', 'status', 'priority', 'updated'], maxResults: 100
  });
  const d = JSON.parse(res.body);
  return { label, total: (d.issues || []).length, issues: d.issues || [] };
}

// 1. Status-fordeling per kategori
const inReview = await search('project = BIZZ AND status = "In Review" ORDER BY priority DESC', 'In Review');
const inProgress = await search('project = BIZZ AND status = "In Progress" ORDER BY priority DESC', 'In Progress');
const onHold = await search('project = BIZZ AND status = "On Hold" ORDER BY priority DESC', 'On Hold');
const highToDo = await search('project = BIZZ AND status = "To Do" AND priority in (Highest, High) ORDER BY priority DESC, updated DESC', 'To Do (High/Highest)');
const doneToday = await search('project = BIZZ AND status = Done AND resolved >= "2026-04-20" ORDER BY resolved DESC', 'Done today (2026-04-20)');

// 2. Tickets opdateret i dag
const updatedToday = await search('project = BIZZ AND updated >= "2026-04-20" ORDER BY updated DESC', 'Opdateret i dag');

console.log('═══ JIRA STATUS 2026-04-20 (BizzAssist) ═══\n');

for (const batch of [inReview, inProgress, onHold]) {
  console.log(`┌─ ${batch.label.toUpperCase()} — ${batch.total} tickets`);
  for (const i of batch.issues.slice(0, 15)) {
    const p = i.fields.priority?.name || '?';
    console.log(`│  ${i.key.padEnd(10)} (${p.padEnd(7)})  ${i.fields.summary.slice(0, 75)}`);
  }
  if (batch.issues.length > 15) console.log(`│  … og ${batch.issues.length - 15} flere`);
  console.log('└────\n');
}

console.log(`┌─ TO DO (High/Highest priority only) — ${highToDo.total} tickets`);
for (const i of highToDo.issues.slice(0, 20)) {
  const p = i.fields.priority?.name || '?';
  console.log(`│  ${i.key.padEnd(10)} (${p.padEnd(7)})  ${i.fields.summary.slice(0, 75)}`);
}
if (highToDo.issues.length > 20) console.log(`│  … og ${highToDo.issues.length - 20} flere`);
console.log('└────\n');

console.log(`┌─ DONE I DAG — ${doneToday.total} tickets`);
for (const i of doneToday.issues.slice(0, 20)) {
  console.log(`│  ${i.key.padEnd(10)}  ${i.fields.summary.slice(0, 75)}`);
}
if (doneToday.issues.length > 20) console.log(`│  … og ${doneToday.issues.length - 20} flere`);
console.log('└────\n');

console.log(`Total aktivitet i dag: ${updatedToday.total} tickets opdateret`);
