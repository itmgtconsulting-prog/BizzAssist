/**
 * BIZZ-735: Backfill supabase_migrations.schema_migrations across test/dev/prod
 * to align with the local migration files in supabase/migrations/.
 *
 * - test-env: creates the schema + table first (it's missing today).
 * - dev-env:  already has 001-036 tracked; backfills 037-060.
 * - prod-env: already has 001-022 tracked; backfills 023-060.
 *
 * Missing rows are inserted with an empty `statements` array — matching the
 * shape Supabase CLI writes when `statements` isn't known (tracking-only).
 *
 * Safe to re-run: INSERT ... ON CONFLICT DO NOTHING means no duplicate rows.
 */
import { readFileSync, readdirSync } from 'fs';

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

// Collect local migrations
const LOCAL = readdirSync('supabase/migrations')
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort()
  .map((f) => {
    const m = f.match(/^(\d{3})_(.+)\.sql$/);
    return { version: m[1], name: m[2], file: f };
  });

console.log(`Found ${LOCAL.length} local migrations: ${LOCAL[0].version}..${LOCAL[LOCAL.length - 1].version}`);

async function sql(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const d = await res.json();
  if (d.message) throw new Error(d.message);
  return d;
}

async function main() {
  for (const e of ENVS) {
    console.log(`\n═══ ${e.name} (${e.ref}) ═══`);

    // Step 1: Ensure schema + table exist
    try {
      await sql(
        e.ref,
        `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
         CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
           version text NOT NULL PRIMARY KEY,
           statements text[] DEFAULT '{}',
           name text
         );`
      );
      console.log('  schema_migrations table ensured');
    } catch (err) {
      console.error(`  ERROR ensuring table: ${err.message}`);
      continue;
    }

    // Step 2: Check which versions already tracked
    const existing = await sql(
      e.ref,
      `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`
    );
    const existingSet = new Set(existing.map((r) => r.version));
    console.log(`  already tracked: ${existingSet.size} migrations`);

    // Step 3: Insert missing
    const missing = LOCAL.filter((m) => !existingSet.has(m.version));
    if (missing.length === 0) {
      console.log('  no backfill needed');
      continue;
    }
    const values = missing
      .map((m) => `('${m.version}', '${m.name.replace(/'/g, "''")}', '{}')`)
      .join(',');
    await sql(
      e.ref,
      `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
       VALUES ${values}
       ON CONFLICT (version) DO NOTHING`
    );
    console.log(
      `  backfilled ${missing.length} migrations: ${missing[0].version}..${missing[missing.length - 1].version}`
    );
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
