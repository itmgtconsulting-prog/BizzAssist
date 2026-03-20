/**
 * Migration runner for BizzAssist Supabase database.
 *
 * Uses the Supabase Management API to execute SQL directly —
 * no direct database connection or IPv4 add-on required.
 *
 * Reads all .sql files from supabase/migrations/ in lexicographic
 * order (001_, 002_, …) and applies each one individually.
 * Skips ALL_MIGRATIONS.sql (the combined convenience file).
 *
 * Usage:
 *   node scripts/run-migrations.mjs              # run all pending
 *   node scripts/run-migrations.mjs 005          # run a specific file
 *
 * Prerequisites:
 *   SUPABASE_ACCESS_TOKEN in .env.local
 *   NEXT_PUBLIC_SUPABASE_URL   in .env.local
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// ── Load .env.local ──────────────────────────────────────────

const envLines = fs.readFileSync(path.join(projectRoot, '.env.local'), 'utf8').split('\n');
const env = {};
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx === -1) continue;
  env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
}

const accessToken = env['SUPABASE_ACCESS_TOKEN'];
const supabaseUrl = env['NEXT_PUBLIC_SUPABASE_URL'];

if (!accessToken) {
  console.error('ERROR: SUPABASE_ACCESS_TOKEN not found in .env.local');
  console.error('  Get one at: https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}

// Extract project ref from URL  (https://xyzabc.supabase.co → xyzabc)
const projectRef = supabaseUrl?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
if (!projectRef) {
  console.error('ERROR: Could not parse project ref from NEXT_PUBLIC_SUPABASE_URL');
  process.exit(1);
}

const apiBase = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

// ── SQL executor ─────────────────────────────────────────────

/**
 * Executes a SQL string against the Supabase project via Management API.
 *
 * @param {string} sql - The SQL to execute
 * @returns {{ ok: boolean, data: unknown, error: string|null }}
 */
async function execSQL(sql) {
  const res = await fetch(apiBase, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (res.status >= 400) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    return { ok: false, data, error: msg };
  }
  return { ok: true, data, error: null };
}

// ── Collect migration files ──────────────────────────────────

const migrationsDir = path.join(projectRoot, 'supabase', 'migrations');
const filter = process.argv[2]; // optional: '005' to run only files matching

const files = fs
  .readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql') && !f.startsWith('ALL_'))
  .filter(f => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.log(filter ? `No migration files matching "${filter}"` : 'No migration files found.');
  process.exit(0);
}

console.log(`Project: ${projectRef}`);
console.log(`Running ${files.length} migration(s):\n`);

// ── Run each migration ───────────────────────────────────────

let passed = 0;
let failed = 0;

for (const file of files) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  process.stdout.write(`  ${file} ... `);

  const { ok, error } = await execSQL(sql);

  if (ok) {
    console.log('✓');
    passed++;
  } else {
    console.log('✗ FAILED');
    console.error(`    ${error}\n`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
