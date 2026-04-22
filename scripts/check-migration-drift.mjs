/**
 * BIZZ-735: Migration drift check across test/dev/prod Supabase environments.
 *
 * Compares supabase_migrations.schema_migrations contents with the local
 * supabase/migrations/ files and fails (exit 1) if any environment is missing
 * a migration that exists locally. Can be wired into a weekly GitHub Actions
 * workflow to catch silent drift (the BIZZ-735 incident mode).
 *
 * Usage:
 *   node scripts/check-migration-drift.mjs
 *
 * Requires SUPABASE_ACCESS_TOKEN in .env.local (or process.env).
 */
import { readFileSync, readdirSync, existsSync } from 'fs';

const env = existsSync('.env.local')
  ? Object.fromEntries(
      readFileSync('.env.local', 'utf8')
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
          return m ? [m[1], m[2]] : [null, null];
        })
        .filter(([k]) => k)
    )
  : {};

const TOKEN = env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN not set');
  process.exit(2);
}

const ENVS = [
  { name: 'test', ref: 'rlkjmqjxmkxuclehbrnl' },
  { name: 'dev', ref: 'wkzwxfhyfmvglrqtmebw' },
  { name: 'prod', ref: 'xsyldjqcntiygrtfcszm' },
];

const LOCAL = readdirSync('supabase/migrations')
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort()
  .map((f) => f.match(/^(\d{3})_/)[1]);

async function sql(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

async function main() {
  console.log(`Local migrations: ${LOCAL.length} (${LOCAL[0]}..${LOCAL[LOCAL.length - 1]})\n`);

  let drift = false;
  for (const e of ENVS) {
    const rows = await sql(
      e.ref,
      `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`
    );
    if (rows.message) {
      console.error(`${e.name}: ERROR ${rows.message}`);
      drift = true;
      continue;
    }
    const tracked = new Set(rows.map((r) => r.version));
    const missing = LOCAL.filter((v) => !tracked.has(v));
    const extra = [...tracked].filter((v) => !LOCAL.includes(v));
    const status = missing.length === 0 && extra.length === 0 ? '✓ in sync' : '✗ DRIFT';
    console.log(`${e.name.padEnd(5)} ${status}  (tracked: ${tracked.size})`);
    if (missing.length > 0) {
      console.log(`  missing locally → env: ${missing.join(', ')}`);
      drift = true;
    }
    if (extra.length > 0) {
      console.log(`  extra in env (not in repo): ${extra.join(', ')}`);
      // Extra is a warning, not a failure — could be legitimate (hotfix)
    }
  }

  if (drift) {
    console.error('\nDRIFT detected — see output above.');
    process.exit(1);
  }
  console.log('\nAll environments in sync.');
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
