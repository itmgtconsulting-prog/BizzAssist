#!/usr/bin/env node
/**
 * Backfill: add domain.created_by as admin member on any domain_member-less
 * domain rows. Fixes BIZZ-737 follow-up where super-admins could create a
 * domain but not navigate into it because no membership row was inserted.
 *
 * Runs on all 3 envs via Supabase Management API.
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

async function runSql(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

const BACKFILL_SQL = `
-- Add created_by as admin member for domains that have no membership yet.
INSERT INTO public.domain_member (domain_id, user_id, role, invited_by, joined_at)
SELECT d.id, d.created_by, 'admin', d.created_by, now()
FROM public.domain d
WHERE d.created_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.domain_member dm
    WHERE dm.domain_id = d.id AND dm.user_id = d.created_by
  )
RETURNING domain_id, user_id;
`;

for (const e of ENVS) {
  console.log(`\n═══ ${e.name} (${e.ref}) ═══`);
  const r = await runSql(e.ref, BACKFILL_SQL);
  console.log(JSON.stringify(r).slice(0, 400));
}
