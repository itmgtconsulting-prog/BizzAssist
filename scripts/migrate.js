#!/usr/bin/env node
/**
 * BizzAssist database migration guide script.
 *
 * Lists all pending SQL migration files from supabase/migrations/ in order
 * and guides the developer to apply them via the Supabase CLI.
 *
 * Actual migration execution is handled by the Supabase CLI — this script
 * does NOT run SQL directly. Use `node scripts/run-migrations.mjs` for
 * direct execution via the Supabase Management API.
 *
 * Usage:
 *   node scripts/migrate.js            # list migrations + show CLI instructions
 *   node scripts/migrate.js --reset    # show reset + re-seed instructions
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const migrationsDir = path.join(projectRoot, 'supabase', 'migrations');

const isReset = process.argv.includes('--reset');

const DIVIDER = '─'.repeat(60);

console.log(DIVIDER);
console.log('  BizzAssist — Database Migration Tool');
console.log(DIVIDER);

if (isReset) {
  console.log('\n  MODE: RESET\n');
  console.log('  WARNING: This will wipe ALL data in your local Supabase instance.');
  console.log('  Never run this against production.\n');
  console.log('  To reset and re-apply all migrations:\n');
  console.log('    supabase db reset\n');
  console.log('  This command:');
  console.log('    1. Drops all schemas in your local DB');
  console.log('    2. Re-applies every migration from supabase/migrations/');
  console.log('    3. Re-runs seed.sql if present\n');
  console.log('  After reset, seed dev data:');
  console.log('    npm run db:seed\n');
  console.log(DIVIDER);
  process.exit(0);
}

// Read migration files in lexicographic order
/** @type {string[]} */
let files = [];
try {
  files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('ALL_'))
    .sort();
} catch {
  console.error(`\n  ERROR: Could not read migrations directory: ${migrationsDir}`);
  console.error('  Ensure supabase/migrations/ exists.\n');
  process.exit(1);
}

if (files.length === 0) {
  console.log('\n  No migration files found in supabase/migrations/\n');
  process.exit(0);
}

console.log(`\n  Found ${files.length} migration file(s):\n`);
files.forEach((file, idx) => {
  console.log(`    ${String(idx + 1).padStart(3, ' ')}. ${file}`);
});

console.log('\n' + DIVIDER);
console.log('\n  HOW TO APPLY MIGRATIONS\n');
console.log('  Option 1 — Supabase CLI (recommended for local dev):');
console.log('    supabase migration up\n');
console.log('  Option 2 — Supabase CLI push (syncs local → linked remote):');
console.log('    supabase db push\n');
console.log('  Option 3 — Management API (CI / no CLI):');
console.log('    node scripts/run-migrations.mjs\n');
console.log('  Option 4 — Single migration:');
console.log('    node scripts/run-migrations.mjs 005\n');
console.log(DIVIDER);
console.log('\n  PREREQUISITES\n');
console.log('  Local dev:');
console.log('    - Docker Desktop running');
console.log('    - supabase start (starts local Supabase stack)');
console.log('    - supabase link --project-ref <ref> (for push)\n');
console.log('  Management API:');
console.log('    - SUPABASE_ACCESS_TOKEN in .env.local');
console.log('    - NEXT_PUBLIC_SUPABASE_URL in .env.local\n');
console.log(DIVIDER + '\n');
