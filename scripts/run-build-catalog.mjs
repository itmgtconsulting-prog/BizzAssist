#!/usr/bin/env node
/**
 * Manual catalog refresh — kører buildAndUpsertCatalog mod den env der peges på
 * via NEXT_PUBLIC_SUPABASE_URL + SUPABASE_ACCESS_TOKEN i .env.local.
 *
 * Brug:
 *   node scripts/run-build-catalog.mjs        # dev (default)
 *   PROJECT_REF=rlkjmqjxmkxuclehbrnl node scripts/run-build-catalog.mjs  # test
 */

import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

// Override PROJECT_REF hvis sat via env-var (skifter target).
if (process.env.PROJECT_REF) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${process.env.PROJECT_REF}.supabase.co`;
}

// tsx-loader pattern: kører .ts direkte
const { buildAndUpsertCatalog } = await import('../app/lib/dataIntelligence/buildCatalog.ts');

const start = Date.now();
const { results } = await buildAndUpsertCatalog();
const duration = Date.now() - start;

console.log(`\n=== Catalog refresh complete (${duration}ms) ===`);
for (const r of results) {
  const status = r.error ? `FAIL: ${r.error}` : `${r.rows} rows`;
  console.log(`  ${r.table.padEnd(40)} | ${r.durationMs}ms | ${status}`);
}
const failed = results.filter((r) => r.error).length;
console.log(`\n${results.length - failed}/${results.length} tables succeeded.`);
process.exit(failed === 0 ? 0 : 1);
