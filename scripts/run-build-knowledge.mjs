#!/usr/bin/env node
/**
 * Manual knowledge cache refresh — kører buildAndUpsertKnowledge mod
 * den env der peges på via NEXT_PUBLIC_SUPABASE_URL i .env.local.
 *
 * Brug:
 *   node scripts/run-build-knowledge.mjs        # dev
 *   PROJECT_REF=rlkjmqjxmkxuclehbrnl node scripts/run-build-knowledge.mjs  # test
 */

import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

if (process.env.PROJECT_REF) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${process.env.PROJECT_REF}.supabase.co`;
}

const { buildAndUpsertKnowledge } = await import('../app/lib/dataIntelligence/buildKnowledge.ts');

const start = Date.now();
const { results } = await buildAndUpsertKnowledge();
const duration = Date.now() - start;

console.log(`\n=== Knowledge refresh complete (${duration}ms) ===`);
for (const r of results) {
  const status = r.error ? `FAIL: ${r.error}` : `${r.rows} rows`;
  console.log(`  ${r.topic.padEnd(40)} | ${r.durationMs}ms | ${status}`);
}
const failed = results.filter((r) => r.error).length;
console.log(`\n${results.length - failed}/${results.length} topics succeeded.`);
process.exit(failed === 0 ? 0 : 1);
