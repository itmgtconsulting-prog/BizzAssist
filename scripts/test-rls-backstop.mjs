#!/usr/bin/env node
/**
 * RLS Cross-Tenant Backstop Regression — scripts/test-rls-backstop.mjs
 *
 * BIZZ-2274 (locks the whole BIZZ-2243 chain: 2271 reads + 2272 writes via the
 * `authenticated` role). Proves that the Row Level Security backstop blocks a
 * cross-tenant access even when the APP LAYER has a scoping bug — i.e. even when
 * code targets ANOTHER tenant's schema directly, a non-member sees 0 rows and
 * cannot write. This is the defence-in-depth guarantee behind routing tenant
 * reads/writes through tenantUserDb() instead of the service_role admin client.
 *
 * Why role-simulation (not the JS client): in test/prod the per-tenant schemas
 * ARE exposed via PostgREST (so the authenticated user client can reach its OWN
 * schema — verified: /api/tracked → 200). Structural "schema not exposed" isolation
 * therefore does NOT hold there; RLS is the operative control. We simulate the
 * exact authenticated-role code path at the DB level via the Supabase Management
 * API (SET LOCAL role authenticated + request.jwt.claims), so the test exercises
 * the real policy (is_tenant_member(auth.uid())) rather than a mock.
 *
 * Env: SUPABASE_ACCESS_TOKEN (from .env.local). Target project ref via
 * RLS_BACKSTOP_REF (default = test env serving test.bizzassist.dk). Read-only
 * except one INSERT attempt wrapped in a rolled-back transaction (never persists).
 *
 * Skips (exit 0) if creds/tenants are unavailable so it is CI-safe.
 * Exit codes: 0 = pass/skip, 1 = isolation breach.
 *
 * Run: node scripts/test-rls-backstop.mjs   (or: npm run test:rls:backstop)
 * ISO 27001 A.9 (Access Control) regression guard.
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') });

const REF = process.env.RLS_BACKSTOP_REF || 'rlkjmqjxmkxuclehbrnl'; // test env
const token = process.env.SUPABASE_ACCESS_TOKEN;

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

if (!token) {
  console.log(`${DIM}SUPABASE_ACCESS_TOKEN not set — skipping RLS backstop test (CI-safe skip).${RESET}`);
  process.exit(0);
}

/**
 * Runs SQL via the Supabase Management API against the target project.
 * @param {string} sql - the SQL to execute
 * @returns {Promise<Array>} result rows
 * @throws if the API returns an error object (e.g. an RLS violation)
 */
async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const j = await r.json();
  if (!Array.isArray(j)) {
    const msg = j?.message || JSON.stringify(j);
    const err = new Error(msg);
    err.pgError = j;
    throw err;
  }
  return j;
}

/** Builds a `SET LOCAL` prefix that simulates the authenticated role for a user. */
function asUser(userId) {
  return `set local role authenticated;\n  set local request.jwt.claims = '{"sub":"${userId}","role":"authenticated"}';\n`;
}

let passed = 0;
let failed = 0;
/**
 * Records a single assertion result.
 * @param {boolean} ok - whether the assertion held
 * @param {string} name - human-readable assertion label
 */
function assert(ok, name) {
  if (ok) {
    passed++;
    console.log(`  ${GREEN}✓${RESET} ${name}`);
  } else {
    failed++;
    console.log(`  ${RED}✗ ${name}${RESET}`);
  }
}

console.log(`${BOLD}RLS cross-tenant backstop regression (BIZZ-2274) — project ${REF}${RESET}`);

// ── Discover a target tenant WITH rows + an attacker member from another tenant ──
// Dynamic (no hardcoded seed) so the guard survives data changes across envs.
const tenants = await q(`
  select t.schema_name, t.id as tenant_id,
    (select tm.user_id from public.tenant_memberships tm where tm.tenant_id = t.id limit 1) as member
  from public.tenants t
  where t.schema_name is not null
  order by t.created_at
`);
const withMember = tenants.filter((t) => t.member);

// Tables to probe for the read backstop (any tenant-scoped, member-readable table).
const TABLES = ['saved_entities', 'reports', 'notifications'];

// Find a "target" tenant that actually has rows in one of the probe tables.
let target = null;
let targetTable = null;
for (const t of withMember) {
  for (const tbl of TABLES) {
    try {
      const c = await q(`select count(*)::int n from ${t.schema_name}.${tbl}`);
      if (c[0].n > 0) {
        target = t;
        targetTable = tbl;
        break;
      }
    } catch {
      /* table may not exist in this schema — ignore */
    }
  }
  if (target) break;
}
const attacker = withMember.find((t) => target && t.schema_name !== target.schema_name);

if (!target || !attacker) {
  console.log(`${DIM}No target-tenant-with-rows + distinct attacker found — skipping (CI-safe).${RESET}`);
  process.exit(0);
}

console.log(
  `${DIM}target=${target.schema_name}.${targetTable} (member ${String(target.member).slice(0, 8)}…), ` +
    `attacker=${attacker.schema_name} (member ${String(attacker.member).slice(0, 8)}…)${RESET}`
);

// ── 1. service_role sees the target rows (data exists; documented RLS bypass) ──
const svc = await q(`select count(*)::int n from ${target.schema_name}.${targetTable}`);
assert(svc[0].n > 0, `service_role sees ${svc[0].n} row(s) in target (bypass — data exists to leak)`);

// ── 2. READ BACKSTOP: attacker (non-member) reading target → 0 rows ──
// This is the core BIZZ-2274 guarantee: even targeting another tenant's schema
// directly (simulated app-layer scoping bug), RLS returns 0 for a non-member.
const leak = await q(`${asUser(attacker.member)}
  select count(*)::int n from ${target.schema_name}.${targetTable};`);
assert(
  leak[0].n === 0,
  `authenticated non-member reads target.${targetTable} → ${leak[0].n} rows (RLS backstop blocks cross-tenant read)`
);

// ── 3. No over-blocking: the target's OWN member still sees its rows ──
const own = await q(`${asUser(target.member)}
  select count(*)::int n from ${target.schema_name}.${targetTable};`);
assert(
  own[0].n > 0,
  `authenticated member reads own target.${targetTable} → ${own[0].n} rows (member still sees own data)`
);

// ── 4. WRITE BACKSTOP: attacker INSERT into target.saved_entities → blocked ──
// Wrapped in a rolled-back transaction so nothing persists even on an unexpected
// success. A blocked write raises "row-level security" → q() throws → PASS.
let writeBlocked = false;
try {
  await q(`begin;
  ${asUser(attacker.member)}
  insert into ${target.schema_name}.saved_entities
    (tenant_id, entity_type, entity_id, entity_data, is_monitored, created_by)
  values ('${target.tenant_id}', 'property', 'rls-2274-leak-probe', '{}'::jsonb, false, '${attacker.member}');
  rollback;`);
  // Reached here without error → the INSERT was NOT blocked by RLS.
  writeBlocked = false;
} catch (e) {
  // RLS WITH CHECK rejection (or the tx aborted) — the desired outcome.
  writeBlocked = /row-level security|violates|permission denied|insufficient/i.test(e.message);
}
assert(writeBlocked, 'authenticated non-member INSERT into target.saved_entities is RLS-blocked (write backstop)');

// Safety net: ensure the probe row never persisted (defensive; tx rollback should cover it).
const probe = await q(
  `select count(*)::int n from ${target.schema_name}.saved_entities where entity_id = 'rls-2274-leak-probe'`
);
assert(probe[0].n === 0, 'no leak-probe row persisted in target (transaction rolled back cleanly)');

console.log(`\n${BOLD}${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}`);
process.exit(failed === 0 ? 0 : 1);
