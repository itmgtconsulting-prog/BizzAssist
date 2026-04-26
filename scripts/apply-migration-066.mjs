/**
 * BIZZ-720: Apply migration 066_domain_stripe_wiring.sql to all 3 envs
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

const SQL = readFileSync('supabase/migrations/066_domain_stripe_wiring.sql', 'utf8');

async function runSql(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

async function main() {
  for (const e of ENVS) {
    console.log(`\n═══ ${e.name} (${e.ref}) ═══`);
    const r = await runSql(e.ref, SQL);
    if (r.message) {
      if (String(r.message).includes('already exists')) {
        console.log('  partial re-run (some objects already exist) — continuing');
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
       VALUES ('066', 'domain_stripe_wiring', '{}')
       ON CONFLICT (version) DO NOTHING`
    );
    if (mark.message && !String(mark.message).includes('already exists')) {
      console.log('  tracking note:', String(mark.message).substring(0, 200));
    } else {
      console.log('  tracking entry ensured');
    }
    // Verify
    const verify = await runSql(
      e.ref,
      `SELECT plan_id, price_dkk, ai_tokens_per_month FROM plan_configs WHERE plan_id='enterprise_domain';`
    );
    console.log('  plan_configs:', JSON.stringify(verify).slice(0, 200));
    const verify2 = await runSql(
      e.ref,
      `SELECT column_name FROM information_schema.columns WHERE table_name='domain' AND column_name LIKE 'stripe_%';`
    );
    console.log('  domain cols:', JSON.stringify(verify2).slice(0, 200));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
