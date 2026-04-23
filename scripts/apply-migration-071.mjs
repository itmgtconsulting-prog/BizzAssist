/**
 * Apply migration 071 (case-doc generation_id link) to dev+test+prod.
 */
import { readFileSync } from 'node:fs';
import 'dotenv/config';

const SQL = readFileSync(
  new URL('../supabase/migrations/071_case_doc_generation_link.sql', import.meta.url),
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
const results = await Promise.all(PROJECTS.map(runOn));
process.exit(results.every(Boolean) ? 0 : 1);
