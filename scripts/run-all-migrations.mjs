/**
 * Koer ALLE migrationer paa et Supabase-miljoe via Management API.
 *
 * Laeser alle .sql filer fra supabase/migrations/ (undtagen ALL_MIGRATIONS.sql),
 * sorterer numerisk og koerer dem sekventielt.
 * Alle migrationer er idempotente (IF NOT EXISTS / DO-blocks).
 *
 * @example
 *   node scripts/run-all-migrations.mjs --env=prod
 *   node scripts/run-all-migrations.mjs --env=dev --from=050 --to=060
 *   node scripts/run-all-migrations.mjs --env=test --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN mangler i .env.local');
  process.exit(1);
}

const refs = {
  dev: 'wkzwxfhyfmvglrqtmebw',
  test: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
};

/* ── CLI args ──────────────────────────────────────────────── */
const args = process.argv.slice(2);
function getArg(name) {
  const a = args.find((a) => a.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : null;
}
const targetEnv = getArg('env');
const fromNum = getArg('from') ? parseInt(getArg('from'), 10) : null;
const toNum = getArg('to') ? parseInt(getArg('to'), 10) : null;
const dryRun = args.includes('--dry-run');

if (!targetEnv || !refs[targetEnv]) {
  console.error('Usage: node run-all-migrations.mjs --env=<dev|test|prod> [--from=NNN] [--to=NNN] [--dry-run]');
  process.exit(1);
}

const ref = refs[targetEnv];

/* ── Indlaes og sorter migrationsfiler ─────────────────────── */
const migrationsDir = path.resolve(__dirname, '..', 'supabase', 'migrations');
const allFiles = fs.readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql') && f !== 'ALL_MIGRATIONS.sql')
  .sort((a, b) => {
    const numA = parseInt(a.split('_')[0], 10);
    const numB = parseInt(b.split('_')[0], 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b);
  });

/* ── Filtrer paa range ─────────────────────────────────────── */
const filtered = allFiles.filter((f) => {
  const num = parseInt(f.split('_')[0], 10);
  if (fromNum !== null && num < fromNum) return false;
  if (toNum !== null && num > toNum) return false;
  return true;
});

console.log(`\n=== ${dryRun ? '[DRY RUN] ' : ''}Migrationer paa ${targetEnv} (${ref}) ===`);
console.log(`Filer: ${filtered.length} af ${allFiles.length} total\n`);

if (dryRun) {
  for (const f of filtered) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    console.log(`  ${f} (${sql.length} bytes)`);
  }
  console.log(`\n${filtered.length} migrationer ville blive koert.`);
  process.exit(0);
}

/* ── Koer migrationer ──────────────────────────────────────── */
async function runQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await r.text();
  return { status: r.status, body };
}

let ok = 0;
let skipped = 0;
let failed = 0;
const failures = [];

for (const file of filtered) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  const start = Date.now();
  process.stdout.write(`${file.padEnd(55)} ${String(sql.length).padStart(6)} bytes ... `);

  const result = await runQuery(sql);
  const elapsed = Date.now() - start;

  if (result.status === 200 || result.status === 201) {
    /* Tjek om body indeholder fejl (Supabase returnerer 201 med fejl-JSON) */
    let hasError = false;
    try {
      const parsed = JSON.parse(result.body);
      if (parsed && typeof parsed === 'object' && parsed.error) {
        hasError = true;
      }
    } catch { /* ikke JSON = OK */ }

    if (hasError) {
      const bodyStr = result.body.slice(0, 300);
      if (bodyStr.includes('already exists') || bodyStr.includes('duplicate') || bodyStr.includes('does not exist')) {
        console.log(`SKIP (${elapsed}ms) — already exists`);
        skipped++;
      } else {
        console.log(`FEJL (${elapsed}ms)`);
        console.log(`   ${bodyStr}`);
        failures.push(file);
        failed++;
      }
    } else {
      console.log(`OK (${elapsed}ms)`);
      ok++;
    }
  } else {
    const bodyStr = result.body.slice(0, 300);
    if (bodyStr.includes('already exists') || bodyStr.includes('duplicate key')) {
      console.log(`SKIP (${elapsed}ms) — already exists`);
      skipped++;
    } else {
      console.log(`FEJL HTTP ${result.status} (${elapsed}ms)`);
      console.log(`   ${bodyStr}`);
      failures.push(file);
      failed++;
      /* Fortsaet i stedet for at stoppe — migrationer er uafhaengige */
    }
  }
}

/* ── Opsummering ───────────────────────────────────────────── */
console.log(`\n${'─'.repeat(60)}`);
console.log(`Resultat for ${targetEnv}:`);
console.log(`  OK:      ${ok}`);
console.log(`  Skipped: ${skipped}`);
console.log(`  Failed:  ${failed}`);
if (failures.length > 0) {
  console.log(`\nFejlede migrationer:`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log();
