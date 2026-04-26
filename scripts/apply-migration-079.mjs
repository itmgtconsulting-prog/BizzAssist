/**
 * Apply migration 079 (tenant_invitations) to dev+test+prod.
 * BIZZ-271 — self-serve team management.
 */
import { readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const SQL = readFileSync(
  new URL('../supabase/migrations/079_tenant_invitations.sql', import.meta.url),
  'utf8'
);
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Missing SUPABASE_ACCESS_TOKEN');
  process.exit(1);
}
const PROJECTS = [
  { name: 'dev', ref: 'wkzwxfhyfmvglrqtmebw' },
  { name: 'test', ref: 'rlkjmqjxmkxuclehbrnl' },
  { name: 'prod', ref: 'xsyldjqcntiygrtfcszm' },
];
async function runOn(p) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${p.ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error(`✗ ${p.name}: ${r.status} ${txt}`);
    return false;
  }
  console.log(`✓ ${p.name}: applied`);
  return true;
}
const results = [];
for (const p of PROJECTS) {
  results.push(await runOn(p));
}
process.exit(results.every(Boolean) ? 0 : 1);
