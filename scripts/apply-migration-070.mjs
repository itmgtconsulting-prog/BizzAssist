/**
 * Apply migration 070 (domain_case customer link) to dev + test + prod
 * via Supabase Management API.
 *
 * Usage: node scripts/apply-migration-070.mjs
 */
import { readFileSync } from 'node:fs';
import 'dotenv/config';

const SQL = readFileSync(
  new URL('../supabase/migrations/070_domain_case_customer_link.sql', import.meta.url),
  'utf8'
);

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Missing SUPABASE_ACCESS_TOKEN in .env.local');
  process.exit(1);
}

const PROJECTS = [
  { name: 'dev', ref: 'wkzwxfhyfmvglrqtmebw' },
  { name: 'test', ref: 'rlkjmqjxmkxuclehbrnl' },
  { name: 'prod', ref: 'xsyldjqcntiygrtfcszm' },
];

async function runOn(project) {
  const url = `https://api.supabase.com/v1/projects/${project.ref}/database/query`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: SQL }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`✗ ${project.name}: ${r.status} ${text}`);
    return false;
  }
  console.log(`✓ ${project.name}: applied`);
  return true;
}

const results = await Promise.all(PROJECTS.map(runOn));
const ok = results.every(Boolean);
console.log(ok ? '\n✅ all environments migrated' : '\n❌ one or more failed');
process.exit(ok ? 0 : 1);
