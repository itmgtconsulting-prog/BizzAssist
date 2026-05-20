#!/usr/bin/env node
/**
 * PII-in-DB Audit — scanner tekst-felter i Supabase for CPR-patterns.
 *
 * BIZZ-1703 AC E: Køres månedligt som cron eller manuelt.
 * Bruger Supabase Management API til at køre SQL direkte.
 *
 * Brug:
 *   node scripts/audit-pii-in-db.mjs [--env test|prod]
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(process.cwd(), '.env.local');
const envContent = readFileSync(envPath, 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const TOKEN = env.SUPABASE_ACCESS_TOKEN;
const envArg = process.argv.find(a => a.startsWith('--env='))?.split('=')[1] ?? 'test';
const REFS = {
  test: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
  dev: 'wkzwxfhyfmvglrqtmebw',
};
const REF = REFS[envArg];
if (!REF) { console.error(`Unknown env: ${envArg}`); process.exit(1); }

console.log(`Auditing PII in ${envArg} (${REF})...`);

/** Tables + text columns to scan for CPR patterns */
const TARGETS = [
  { table: 'public.ejf_ejerskab', columns: ['ejer_navn'] },
  { table: 'public.cvr_virksomhed', columns: ['navn'] },
  { table: 'public.cvr_deltager', columns: ['navn'] },
  { table: 'public.bfe_adresse_cache', columns: ['adresse'] },
];

async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SQL failed (${res.status}): ${err.slice(0, 200)}`);
  }
  return res.json();
}

let totalFindings = 0;

for (const target of TARGETS) {
  for (const col of target.columns) {
    try {
      // Regex: 6 digits + optional dash + 4 digits (CPR pattern)
      // Filter: month 01-12, day 01-31
      const sql = `
        SELECT count(*) as cnt
        FROM ${target.table}
        WHERE ${col} ~ '\\d{6}-?\\d{4}'
        AND ${col} ~ '^.*([0-2][0-9]|3[01])(0[1-9]|1[0-2])\\d{2}-?\\d{4}.*$'
        LIMIT 1
      `;
      const rows = await runSql(sql);
      const count = rows[0]?.cnt ?? 0;
      if (count > 0) {
        console.error(`  ❌ ${target.table}.${col}: ${count} rows with CPR-pattern`);
        totalFindings += Number(count);
      } else {
        console.log(`  ✅ ${target.table}.${col}: clean`);
      }
    } catch (err) {
      console.warn(`  ⚠️  ${target.table}.${col}: ${err.message.slice(0, 100)}`);
    }
  }
}

if (totalFindings > 0) {
  console.error(`\n${totalFindings} PII finding(s) in ${envArg} database!`);
  process.exit(1);
} else {
  console.log(`\n✅ No PII patterns found in ${envArg} database.`);
}
