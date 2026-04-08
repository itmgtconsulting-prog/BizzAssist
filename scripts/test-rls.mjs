#!/usr/bin/env node
/**
 * RLS Isolation Test Script — scripts/test-rls.mjs
 *
 * Standalone Node.js script that verifies Supabase Row Level Security policies
 * enforce complete tenant data isolation in the BizzAssist dev environment.
 *
 * Run: node scripts/test-rls.mjs
 *   Or: npm run test:rls:script
 *
 * Does NOT require a build — uses ESM imports directly from node_modules.
 * Credentials are for the dev Supabase project only (non-production).
 *
 * Architecture note:
 *   Per-tenant tables live in isolated PostgreSQL schemas (tenant_jakob_dev,
 *   tenant_rls_test_b, …). PostgREST only exposes the `public` schema, so
 *   cross-schema reads are structurally impossible from the JS client. The RLS
 *   policies provide defence-in-depth for direct DB connections.
 *
 *   This script tests the real PostgREST attack surface: the `public` schema.
 *
 * Test sections:
 *   1. Anon access to protected tables (tenants, subscriptions, memberships)
 *   2. Anon INSERT rejection
 *   3. Public tables readable by anon (plans, plan_configs, sitemap_entries)
 *   4. Own-tenant reads work correctly (tenant A and B sanity checks)
 *   5. Cross-tenant isolation in public schema tables
 *   6. User isolation in public.recent_entities (user_id scoped)
 *   7. Admin-only/blocked tables (support_questions, bbr_tracked_objects)
 *   8. Structural isolation: per-tenant schemas not exposed via PostgREST
 *   9. Service role bypass (intentional — documented expected behaviour)
 *
 * Exit codes:
 *   0 — all tests passed
 *   1 — one or more tests failed
 *
 * ISO 27001 A.9 (Access Control) regression test.
 * BIZZ-141 / BIZZ-142 / BIZZ-143 / BIZZ-144 guard.
 */

import { createClient } from '@supabase/supabase-js';

// ── Configuration ─────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://wkzwxfhyfmvglrqtmebw.supabase.co';

const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indrend4Zmh5Zm12Z2xycXRtZWJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NjY1NzUsImV4cCI6MjA5MTI0MjU3NX0.X27mMiNGMCXr7O7mM6ANrueTRafW8NXp6oWokh3JbPQ';

const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indrend4Zmh5Zm12Z2xycXRtZWJ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTY2NjU3NSwiZXhwIjoyMDkxMjQyNTc1fQ.j9McWuGVDL9gDN9ZebjOqQOd89E7m4CA1AMqnmy5Je0';

/** Tenant A — existing dev tenant (jjrchefen@hotmail.com) */
const TENANT_A = {
  email: 'jjrchefen@hotmail.com',
  password: 'Kongen72',
  tenantId: 'de24c450-9181-43f5-b93b-69eee7519988',
  userId: 'ce8cb5f8-32ed-475d-a742-f9f26c898218',
  schemaName: 'tenant_jakob_dev',
};

/** Tenant B — isolated test tenant provisioned for RLS tests */
const TENANT_B = {
  email: 'rls-test-tenant-b@bizzassist-test.internal',
  password: 'RlsTest2026!',
  tenantId: 'fef40549-ce5c-4d3f-baeb-3207ae140504',
  userId: 'f9bfebf3-1dcb-4b58-9134-ccf345b7fdc4',
  schemaName: 'tenant_rls_test_b',
};

/** Entity ID in public.recent_entities seeded for tenant B user */
const SEED_RECENT_B_ID = 'rls-test-recent-b-only';

// ── ANSI colours ──────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

// ── Test runner ───────────────────────────────────────────────────────────────

/** @type {{ name: string; passed: boolean; note?: string }[]} */
const results = [];

/**
 * Runs a single named test case.
 * Catches exceptions and records pass/fail with colored output.
 *
 * @param {string} name - Human-readable test description
 * @param {() => Promise<void>} fn - Test body — throw to fail, return to pass
 */
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
  } catch (/** @type {unknown} */ err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, note: message });
    console.log(`  ${RED}FAIL${RESET} ${name}`);
    console.log(`       ${DIM}${message}${RESET}`);
  }
}

/**
 * Asserts a condition is truthy — throws with a descriptive message if not.
 *
 * @param {unknown} value   - Value to check
 * @param {string} message  - Error message if assertion fails
 */
function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
}

// ── Client factories ──────────────────────────────────────────────────────────

/**
 * Creates an anonymous Supabase client (no session).
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function makeAnonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Creates a Supabase client authenticated as the given user.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
async function makeAuthenticatedClient(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  return client;
}

/**
 * Creates a service-role admin client.
 * Bypasses ALL RLS — use only for test verification.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function makeAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}BizzAssist RLS Isolation Tests${RESET}`);
console.log(`${DIM}Dev Supabase: ${SUPABASE_URL}${RESET}`);
console.log(`${DIM}Only the public schema is tested (per-tenant schemas are structurally hidden from PostgREST)${RESET}\n`);

const anonClient = makeAnonClient();
const adminClient = makeAdminClient();

console.log('Authenticating test users...');
let clientA;
let clientB;

try {
  clientA = await makeAuthenticatedClient(TENANT_A.email, TENANT_A.password);
  console.log(`  ${GREEN}OK${RESET} Signed in as Tenant A (${TENANT_A.email})`);
} catch (err) {
  console.error(`  ${RED}FAIL${RESET} Cannot sign in as Tenant A: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

try {
  clientB = await makeAuthenticatedClient(TENANT_B.email, TENANT_B.password);
  console.log(`  ${GREEN}OK${RESET} Signed in as Tenant B (${TENANT_B.email})\n`);
} catch (err) {
  console.error(`  ${RED}FAIL${RESET} Cannot sign in as Tenant B: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ── Section 1: Unauthenticated access to protected tables ─────────────────────

console.log(`${BOLD}1. Unauthenticated (anon) access to protected tables${RESET}`);

await test('anon cannot SELECT from public.tenants', async () => {
  const { data } = await anonClient.from('tenants').select('id');
  assert((data ?? []).length === 0, `Expected 0 rows but got ${(data ?? []).length}`);
});

await test('anon cannot SELECT from public.subscriptions', async () => {
  const { data } = await anonClient.from('subscriptions').select('id');
  assert((data ?? []).length === 0, `Expected 0 rows but got ${(data ?? []).length}`);
});

await test('anon cannot SELECT from public.tenant_memberships', async () => {
  const { data } = await anonClient.from('tenant_memberships').select('id');
  assert((data ?? []).length === 0, `Expected 0 rows but got ${(data ?? []).length}`);
});

await test('anon cannot SELECT from public.users', async () => {
  const { data } = await anonClient.from('users').select('id');
  assert((data ?? []).length === 0, `Expected 0 rows but got ${(data ?? []).length}`);
});

await test('anon cannot SELECT from public.support_questions', async () => {
  const { data } = await anonClient.from('support_questions').select('id');
  assert((data ?? []).length === 0, `Expected 0 rows but got ${(data ?? []).length}`);
});

await test('anon cannot INSERT into public.tenants', async () => {
  const { error } = await anonClient
    .from('tenants')
    .insert({ name: 'Evil Anon Corp', schema_name: 'tenant_evil_anon' });
  assert(error !== null, 'Expected RLS to block anon INSERT into tenants but no error returned');
});

await test('anon cannot INSERT into public.tenant_memberships', async () => {
  const { error } = await anonClient.from('tenant_memberships').insert({
    tenant_id: TENANT_B.tenantId,
    user_id: TENANT_B.userId,
    role: 'tenant_admin',
  });
  assert(error !== null, 'Expected RLS to block anon INSERT into tenant_memberships but no error returned');
});

// ── Section 2: Intentionally public tables ────────────────────────────────────

console.log(`\n${BOLD}2. Public tables correctly readable by anon (intentional)${RESET}`);

await test('anon CAN read public.plans (pricing page)', async () => {
  const { data, error } = await anonClient.from('plans').select('id, name');
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert(Array.isArray(data) && data.length >= 1, `Expected >= 1 plan, got ${(data ?? []).length}`);
});

await test('anon CAN read public.plan_configs (feature gating)', async () => {
  // plan_configs has no id column — use plan_id (the primary key)
  const { data, error } = await anonClient.from('plan_configs').select('plan_id');
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert(Array.isArray(data), 'Expected array result');
});

await test('anon CAN read public.sitemap_entries (SEO crawlers)', async () => {
  const { data, error } = await anonClient.from('sitemap_entries').select('id').limit(1);
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert(Array.isArray(data), 'Expected array result');
});

// ── Section 3: Own-tenant access sanity checks ────────────────────────────────

console.log(`\n${BOLD}3. Own-tenant access sanity checks${RESET}`);

await test('tenant A CAN read own tenant record', async () => {
  const { data, error } = await clientA
    .from('tenants')
    .select('id, schema_name')
    .eq('id', TENANT_A.tenantId);
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert((data ?? []).length === 1, `Expected 1 row, got ${(data ?? []).length}`);
  assert(data[0].schema_name === TENANT_A.schemaName, 'Unexpected schema_name');
});

await test('tenant A CAN read own tenant_memberships', async () => {
  const { data, error } = await clientA
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('user_id', TENANT_A.userId);
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert((data ?? []).length > 0, 'Expected at least 1 membership row for tenant A');
});

await test('tenant A CAN read own subscription', async () => {
  const { data, error } = await clientA
    .from('subscriptions')
    .select('id, status')
    .eq('tenant_id', TENANT_A.tenantId);
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert((data ?? []).length > 0, 'Expected at least 1 subscription for tenant A');
});

await test('tenant B CAN read own tenant record', async () => {
  const { data, error } = await clientB
    .from('tenants')
    .select('id, schema_name')
    .eq('id', TENANT_B.tenantId);
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert((data ?? []).length === 1, `Expected 1 row, got ${(data ?? []).length}`);
});

// ── Section 4: Cross-tenant isolation ────────────────────────────────────────

console.log(`\n${BOLD}4. Cross-tenant isolation in public schema${RESET}`);

await test('tenant A membership query only returns own memberships (never tenant B)', async () => {
  const { data, error } = await clientA.from('tenant_memberships').select('tenant_id, user_id');
  assert(error === null, `Unexpected error: ${error?.message}`);
  const rows = data ?? [];
  for (const row of rows) {
    assert(row.user_id === TENANT_A.userId, `Got foreign user_id ${row.user_id} — isolation breach!`);
  }
  const hasTenantB = rows.some((r) => r.tenant_id === TENANT_B.tenantId);
  assert(!hasTenantB, 'Tenant A can see tenant B membership row — isolation breach!');
});

await test('tenant B membership query only returns own memberships (never tenant A)', async () => {
  const { data, error } = await clientB.from('tenant_memberships').select('tenant_id, user_id');
  assert(error === null, `Unexpected error: ${error?.message}`);
  const rows = data ?? [];
  for (const row of rows) {
    assert(row.user_id === TENANT_B.userId, `Got foreign user_id ${row.user_id} — isolation breach!`);
  }
  const hasTenantA = rows.some((r) => r.tenant_id === TENANT_A.tenantId);
  assert(!hasTenantA, 'Tenant B can see tenant A membership row — isolation breach!');
});

await test('tenant A cannot SELECT tenant B tenant record by ID', async () => {
  const { data } = await clientA.from('tenants').select('id').eq('id', TENANT_B.tenantId);
  assert((data ?? []).length === 0, `Expected 0 rows but got ${(data ?? []).length} — isolation breach!`);
});

await test('tenant B cannot SELECT tenant A tenant record by ID', async () => {
  const { data } = await clientB.from('tenants').select('id').eq('id', TENANT_A.tenantId);
  assert((data ?? []).length === 0, `Expected 0 rows but got ${(data ?? []).length} — isolation breach!`);
});

await test('tenant A cannot SELECT tenant B subscription', async () => {
  const { data } = await clientA.from('subscriptions').select('id').eq('tenant_id', TENANT_B.tenantId);
  assert((data ?? []).length === 0, `Expected 0 rows but got ${(data ?? []).length} — isolation breach!`);
});

await test('tenant B cannot SELECT tenant A subscription', async () => {
  const { data } = await clientB.from('subscriptions').select('id').eq('tenant_id', TENANT_A.tenantId);
  assert((data ?? []).length === 0, `Expected 0 rows but got ${(data ?? []).length} — isolation breach!`);
});

// ── Section 5: User isolation in public.recent_entities ──────────────────────

console.log(`\n${BOLD}5. User isolation in public.recent_entities (user_id scoped)${RESET}`);

await test('tenant A user cannot read tenant B user recent_entities rows', async () => {
  const { data, error } = await clientA
    .from('recent_entities')
    .select('id, user_id')
    .eq('entity_id', SEED_RECENT_B_ID);
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert(
    (data ?? []).length === 0,
    `Expected 0 rows but got ${(data ?? []).length} — user isolation breach in recent_entities!`
  );
});

await test('tenant B user CAN read own recent_entities row', async () => {
  const { data, error } = await clientB
    .from('recent_entities')
    .select('id, user_id, entity_id')
    .eq('entity_id', SEED_RECENT_B_ID);
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert(
    (data ?? []).length > 0,
    'Tenant B cannot read own recent_entities seed row — RLS misconfigured!'
  );
  assert(data[0].user_id === TENANT_B.userId, 'Unexpected user_id on own recent_entities row');
});

await test('tenant A cannot INSERT recent_entities with tenant B user_id (spoofing)', async () => {
  const { error } = await clientA.from('recent_entities').insert({
    tenant_id: TENANT_A.tenantId,
    user_id: TENANT_B.userId, // attempt to spoof tenant B's user
    entity_type: 'company',
    entity_id: 'rls-spoofed-user-insert-script',
    display_name: 'Spoofed',
    entity_data: {},
  });
  assert(
    error !== null,
    'Expected RLS to reject user_id spoofing in recent_entities INSERT but no error returned'
  );
});

// ── Section 6: Admin-only and blocked tables ──────────────────────────────────

console.log(`\n${BOLD}6. Admin-only and deny-all tables${RESET}`);

await test('authenticated non-admin cannot SELECT public.support_questions (BIZZ-141)', async () => {
  const { data, error } = await clientB.from('support_questions').select('id');
  const blocked = (data ?? []).length === 0 || error !== null;
  assert(blocked, 'Non-admin can read support_questions — BIZZ-141 regression!');
});

await test('authenticated user cannot SELECT public.bbr_tracked_objects (deny-all policy)', async () => {
  const { data, error } = await clientB.from('bbr_tracked_objects').select('id');
  const blocked = (data ?? []).length === 0 || error !== null;
  assert(blocked, 'User can read bbr_tracked_objects — deny-all policy not working!');
});

await test('authenticated user cannot SELECT public.search_cache (deny-all policy)', async () => {
  const { data, error } = await clientB.from('search_cache').select('id');
  const blocked = (data ?? []).length === 0 || error !== null;
  assert(blocked, 'User can read search_cache — deny-all policy not working!');
});

// ── Section 7: Structural schema isolation ────────────────────────────────────

console.log(`\n${BOLD}7. Structural isolation: per-tenant schemas not exposed via PostgREST${RESET}`);

await test('JS client cannot access tenant_rls_test_b schema (PostgREST schema not exposed)', async () => {
  const { error } = await clientA
    .schema(TENANT_B.schemaName)
    .from('saved_entities')
    .select('id');
  assert(error !== null, 'SECURITY: tenant_rls_test_b schema is exposed via PostgREST — fix immediately!');
  assert(
    error?.code === 'PGRST106',
    `Expected PGRST106 "Invalid schema" error, got: ${error?.code} — ${error?.message}`
  );
});

await test('JS client cannot access tenant_jakob_dev schema (PostgREST schema not exposed)', async () => {
  const { error } = await clientB
    .schema(TENANT_A.schemaName)
    .from('saved_entities')
    .select('id');
  assert(error !== null, 'SECURITY: tenant_jakob_dev schema is exposed via PostgREST — fix immediately!');
  assert(
    error?.code === 'PGRST106',
    `Expected PGRST106 "Invalid schema" error, got: ${error?.code} — ${error?.message}`
  );
});

// ── Section 8: Service role bypass (documented intentional) ───────────────────

console.log(`\n${BOLD}8. Service role RLS bypass (documented intentional behaviour)${RESET}`);

await test('service role CAN read all tenants (RLS bypass — expected for admin operations)', async () => {
  const { data, error } = await adminClient.from('tenants').select('id, schema_name');
  assert(error === null, `Unexpected error: ${error?.message}`);
  const schemas = (data ?? []).map((r) => r.schema_name);
  assert(schemas.includes(TENANT_A.schemaName), 'Service role cannot see tenant A — unexpected');
  assert(schemas.includes(TENANT_B.schemaName), 'Service role cannot see tenant B — unexpected');
});

await test('service role CAN read tenant B subscription (RLS bypass — expected)', async () => {
  const { data, error } = await adminClient
    .from('subscriptions')
    .select('id, tenant_id')
    .eq('tenant_id', TENANT_B.tenantId);
  assert(error === null, `Unexpected error: ${error?.message}`);
  assert((data ?? []).length > 0, 'Service role cannot read tenant B subscription — unexpected');
});

await test('service role CAN read all memberships (RLS bypass — expected)', async () => {
  const { data, error } = await adminClient.from('tenant_memberships').select('tenant_id, user_id');
  assert(error === null, `Unexpected error: ${error?.message}`);
  const tenantIds = (data ?? []).map((r) => r.tenant_id);
  assert(tenantIds.includes(TENANT_A.tenantId), 'Service role cannot see tenant A memberships — unexpected');
  assert(tenantIds.includes(TENANT_B.tenantId), 'Service role cannot see tenant B memberships — unexpected');
});

// ── Sign out ──────────────────────────────────────────────────────────────────

await clientA.auth.signOut();
await clientB.auth.signOut();

// ── Summary ───────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const total = results.length;

console.log(`\n${'─'.repeat(60)}`);
console.log(`${BOLD}Results: ${passed}/${total} passed${RESET}`);

if (failed > 0) {
  console.log(`\n${RED}${BOLD}FAILED TESTS (${failed}):${RESET}`);
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  ${RED}✗${RESET} ${r.name}`);
    if (r.note) console.log(`    ${DIM}${r.note}${RESET}`);
  }
  console.log(
    `\n${RED}${BOLD}RLS ISOLATION AUDIT FAILED — ${failed} test(s) indicate data isolation gaps.${RESET}`
  );
  console.log(
    `${YELLOW}Review the failed tests and check the relevant RLS policies in supabase/migrations/.${RESET}\n`
  );
  process.exit(1);
} else {
  console.log(`\n${GREEN}${BOLD}All ${total} RLS isolation tests passed.${RESET}`);
  console.log(`${GREEN}Tenant data isolation is correctly enforced in the dev Supabase instance.${RESET}\n`);
  process.exit(0);
}
