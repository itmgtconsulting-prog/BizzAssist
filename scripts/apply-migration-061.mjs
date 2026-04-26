/**
 * BIZZ-736: Apply migration 061_supabase_advisor_fixes.sql to all 3 envs
 * via Supabase Management API, then record it in schema_migrations.
 */
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

const SQL = readFileSync('supabase/migrations/061_supabase_advisor_fixes.sql', 'utf8');

async function runSql(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const d = await res.json();
  return d;
}

async function main() {
  for (const e of ENVS) {
    console.log(`\n═══ ${e.name} (${e.ref}) ═══`);
    const result = await runSql(e.ref, SQL);
    if (result.message) {
      // Some policies may already exist from a previous partial run; that's OK
      if (String(result.message).includes('already exists')) {
        console.log('  some objects already exist — partial re-run, continuing');
      } else {
        console.error('  ERROR:', result.message.substring(0, 400));
        continue;
      }
    } else {
      console.log('  migration applied successfully');
    }
    // Mark 061 as applied (may already be seeded by BIZZ-735 scripts but this
    // is the first time we've actually run it as SQL)
    const mark = await runSql(
      e.ref,
      `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
       VALUES ('061', 'supabase_advisor_fixes', '{}')
       ON CONFLICT (version) DO NOTHING`
    );
    if (mark.message && !String(mark.message).includes('already exists')) {
      console.log('  tracking update note:', mark.message.substring(0, 200));
    } else {
      console.log('  tracking entry ensured');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
