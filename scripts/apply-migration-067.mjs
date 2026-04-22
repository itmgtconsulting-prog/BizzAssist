#!/usr/bin/env node
/** BIZZ-743: Apply migration 067_domain_template_document to all 3 envs. */
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
      return m ? [m[1], m[2]] : [null, null];
    })
    .filter(([k]) => k)
);

const TOKEN = env.SUPABASE_ACCESS_TOKEN;
const ENVS = [
  { name: 'test', ref: 'rlkjmqjxmkxuclehbrnl' },
  { name: 'dev', ref: 'wkzwxfhyfmvglrqtmebw' },
  { name: 'prod', ref: 'xsyldjqcntiygrtfcszm' },
];

const SQL = readFileSync('supabase/migrations/067_domain_template_document.sql', 'utf8');

async function runSql(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

for (const e of ENVS) {
  console.log(`\n═══ ${e.name} (${e.ref}) ═══`);
  const r = await runSql(e.ref, SQL);
  if (r.message) {
    if (String(r.message).includes('already exists')) {
      console.log('  partial re-run — continuing');
    } else {
      console.error('  ERROR:', String(r.message).substring(0, 400));
      continue;
    }
  } else {
    console.log('  migration applied');
  }
  const mark = await runSql(
    e.ref,
    `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
     VALUES ('067', 'domain_template_document', '{}')
     ON CONFLICT (version) DO NOTHING`
  );
  console.log('  tracking:', JSON.stringify(mark).slice(0, 150));
  const verify = await runSql(
    e.ref,
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='domain_template_document' ORDER BY ordinal_position;`
  );
  console.log('  cols:', JSON.stringify(verify).slice(0, 300));
}
