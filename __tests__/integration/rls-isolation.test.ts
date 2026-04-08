/**
 * RLS Isolation Integration Tests — __tests__/integration/rls-isolation.test.ts
 *
 * Verifies that Supabase Row Level Security policies enforce complete tenant
 * data isolation in the BizzAssist dev environment.
 *
 * Architecture note:
 *   Per-tenant tables (saved_entities, recent_entities, etc.) live in isolated
 *   PostgreSQL schemas (tenant_jakob_dev, tenant_rls_test_b, …). Supabase
 *   PostgREST only exposes the `public` schema via the REST API, so cross-schema
 *   reads are structurally impossible from the JS client. The RLS policies in
 *   those schemas provide defence-in-depth for direct DB connections.
 *
 *   The real PostgREST attack surface is the `public` schema, which contains:
 *     - public.tenants               — RLS: own-membership only
 *     - public.subscriptions         — RLS: own-membership only
 *     - public.tenant_memberships    — RLS: own-user only
 *     - public.recent_entities       — RLS: own-user only (user_id = auth.uid())
 *     - public.plans / plan_configs  — publicly readable (pricing page)
 *     - public.sitemap_entries       — publicly readable (SEO crawlers)
 *     - public.support_questions     — service_role only (BIZZ-141)
 *     - public.bbr_tracked_objects   — blocked: USING(false)
 *     - public.search_cache          — blocked: USING(false)
 *
 * Test coverage:
 *   1. Unauthenticated (anon) access — protected tables return 0 rows / error
 *   2. Public tables readable by anon — plans, plan_configs, sitemap_entries
 *   3. Own-tenant membership/subscription reads (tenant A and B)
 *   4. Cross-tenant isolation in public.tenant_memberships
 *   5. Cross-tenant isolation in public.subscriptions
 *   6. User isolation in public.recent_entities (user_id scoped)
 *   7. Admin-only table (support_questions) blocked for authenticated users
 *   8. Structural isolation: per-tenant schemas not exposed via PostgREST
 *   9. Service role intentionally bypasses RLS (documented expected behaviour)
 *
 * Skipped by default — requires a live dev Supabase instance and real sessions.
 * Enable with: RLS_TEST=true npx vitest run __tests__/integration/rls-isolation.test.ts
 * Or via:      npm run test:rls
 *
 * ISO 27001 A.9 (Access Control) — verifies enforcement of access boundaries.
 * BIZZ-141 / BIZZ-142 / BIZZ-143 / BIZZ-144 — RLS security fix regression guard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://wkzwxfhyfmvglrqtmebw.supabase.co';

const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indrend4Zmh5Zm12Z2xycXRtZWJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NjY1NzUsImV4cCI6MjA5MTI0MjU3NX0.X27mMiNGMCXr7O7mM6ANrueTRafW8NXp6oWokh3JbPQ';

const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indrend4Zmh5Zm12Z2xycXRtZWJ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTY2NjU3NSwiZXhwIjoyMDkxMjQyNTc1fQ.j9McWuGVDL9gDN9ZebjOqQOd89E7m4CA1AMqnmy5Je0';

/** Tenant A — the existing dev tenant (jjrchefen@hotmail.com / Kongen72) */
const TENANT_A = {
  email: 'jjrchefen@hotmail.com',
  password: 'Kongen72',
  tenantId: 'de24c450-9181-43f5-b93b-69eee7519988',
  userId: 'ce8cb5f8-32ed-475d-a742-f9f26c898218',
  schemaName: 'tenant_jakob_dev',
} as const;

/**
 * Tenant B — isolated test tenant provisioned for RLS tests.
 *   User ID:   f9bfebf3-1dcb-4b58-9134-ccf345b7fdc4
 *   Tenant ID: fef40549-ce5c-4d3f-baeb-3207ae140504
 *   Schema:    tenant_rls_test_b
 *   Role:      tenant_member (not admin)
 */
const TENANT_B = {
  email: 'rls-test-tenant-b@bizzassist-test.internal',
  password: 'RlsTest2026!',
  tenantId: 'fef40549-ce5c-4d3f-baeb-3207ae140504',
  userId: 'f9bfebf3-1dcb-4b58-9134-ccf345b7fdc4',
  schemaName: 'tenant_rls_test_b',
} as const;

/**
 * Entity ID seeded into public.recent_entities for tenant B.
 * Tenant A must NOT be able to see this row.
 */
const SEED_RECENT_B_ID = 'rls-test-recent-b-only';

// ── Suite guard ───────────────────────────────────────────────────────────────

/**
 * Skip the entire suite unless RLS_TEST=true is set.
 * This prevents slow live-Supabase tests from running in the standard CI
 * unit-test job (which uses jsdom and mocked dependencies).
 */
const runRls = process.env['RLS_TEST'] === 'true';
const describeRls = runRls ? describe : describe.skip;

// ── Client factories ──────────────────────────────────────────────────────────

/**
 * Creates an anon Supabase client (no session).
 * Represents an unauthenticated browser visitor.
 *
 * @returns Unauthenticated SupabaseClient using the anon key
 */
function makeAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Creates a Supabase client authenticated as the given user.
 * Signs in with email + password and returns the authed client.
 *
 * @param email    - User email address
 * @param password - User password
 * @returns Authenticated SupabaseClient
 * @throws If sign-in fails
 */
async function makeAuthenticatedClient(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  }
  return client;
}

/**
 * Creates a Supabase admin client using the service role key.
 * Bypasses ALL Row Level Security — use only for test setup/teardown/verification.
 *
 * @returns Service-role SupabaseClient
 */
function makeAdminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Shared client instances ───────────────────────────────────────────────────

/** Unauthenticated client — shared across anon tests */
let anonClient: SupabaseClient;

/** Client authenticated as tenant A user */
let clientA: SupabaseClient;

/** Client authenticated as tenant B user */
let clientB: SupabaseClient;

/** Admin client for setup verification and teardown */
let adminClient: SupabaseClient;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  anonClient = makeAnonClient();
  adminClient = makeAdminClient();
  clientA = await makeAuthenticatedClient(TENANT_A.email, TENANT_A.password);
  clientB = await makeAuthenticatedClient(TENANT_B.email, TENANT_B.password);
});

afterAll(async () => {
  await clientA.auth.signOut();
  await clientB.auth.signOut();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeRls('RLS Isolation — Unauthenticated (anon) access to protected tables', () => {
  /**
   * Anon users must not be able to enumerate tenant records.
   * The "tenants: read own" policy requires a valid membership lookup.
   * Anon JWT has no auth.uid() → subquery returns false → 0 rows.
   */
  it('anon cannot SELECT from public.tenants', async () => {
    const { data, error } = await anonClient.from('tenants').select('id');
    // RLS returns 0 rows (not always an error) when no policy matches
    expect((data ?? []).length).toBe(0);
    // May or may not produce an error depending on policy type — both are acceptable
    if (error) expect(error.code).toBeDefined();
  });

  /**
   * Subscriptions are sensitive billing data — anon must see nothing.
   * The "subscriptions: read own" policy requires a membership subquery.
   */
  it('anon cannot SELECT from public.subscriptions', async () => {
    const { data } = await anonClient.from('subscriptions').select('id');
    expect((data ?? []).length).toBe(0);
  });

  /**
   * Tenant memberships reveal organisational structure — anon must see nothing.
   * The "memberships: read own tenants" policy requires auth.uid() = user_id.
   */
  it('anon cannot SELECT from public.tenant_memberships', async () => {
    const { data } = await anonClient.from('tenant_memberships').select('id');
    expect((data ?? []).length).toBe(0);
  });

  /**
   * Users table contains PII — anon must not access it.
   * "users: read own" policy requires auth.uid() = id.
   */
  it('anon cannot SELECT from public.users', async () => {
    const { data } = await anonClient.from('users').select('id');
    expect((data ?? []).length).toBe(0);
  });

  /**
   * bbr_tracked_objects uses USING(false) — blocks all access.
   */
  it('anon cannot SELECT from public.bbr_tracked_objects (USING false policy)', async () => {
    const { data, error } = await anonClient.from('bbr_tracked_objects').select('id');
    const blocked = (data ?? []).length === 0 || error !== null;
    expect(blocked).toBe(true);
  });

  /**
   * support_questions blocked by "deny authenticated" policy (BIZZ-141).
   * Anon also has no access.
   */
  it('anon cannot SELECT from public.support_questions', async () => {
    const { data } = await anonClient.from('support_questions').select('id');
    expect((data ?? []).length).toBe(0);
  });

  /**
   * Anon INSERT into tenants must be rejected by RLS.
   * There is no INSERT policy for the anon/authenticated role on public.tenants.
   */
  it('anon cannot INSERT into public.tenants', async () => {
    const { error } = await anonClient
      .from('tenants')
      .insert({ name: 'Evil Anon Corp', schema_name: 'tenant_evil_anon' });
    expect(error).not.toBeNull();
  });

  /**
   * Anon INSERT into tenant_memberships must be rejected.
   */
  it('anon cannot INSERT into public.tenant_memberships', async () => {
    const { error } = await anonClient.from('tenant_memberships').insert({
      tenant_id: TENANT_B.tenantId,
      user_id: TENANT_B.userId,
      role: 'tenant_admin',
    });
    expect(error).not.toBeNull();
  });
});

describeRls('RLS Isolation — Public tables accessible by anon (intentional)', () => {
  /**
   * plans table has "plans: read all" policy with USING(true).
   * This is intentional — needed for the pricing page without login.
   */
  it('anon CAN SELECT from public.plans (pricing page data)', async () => {
    const { data, error } = await anonClient.from('plans').select('id, name');
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  /**
   * plan_configs has "plan_configs_read" policy with USING(true).
   * Needed for feature gating on public pages.
   */
  it('anon CAN SELECT from public.plan_configs (feature config)', async () => {
    // plan_configs has no id column — use plan_id (the primary key)
    const { data, error } = await anonClient.from('plan_configs').select('plan_id');
    expect(error).toBeNull();
    // Table may be empty but the query must not error
    expect(Array.isArray(data)).toBe(true);
  });

  /**
   * sitemap_entries is public for SEO crawlers — "sitemap_entries_select_all"
   * grants SELECT to both anon and authenticated roles.
   */
  it('anon CAN SELECT from public.sitemap_entries (SEO crawlers)', async () => {
    const { data, error } = await anonClient.from('sitemap_entries').select('id').limit(1);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });
});

describeRls('RLS Isolation — Own-tenant access (public schema, Tenant A)', () => {
  /**
   * Tenant A must be able to read their own tenant row.
   * "tenants: read own" checks is_tenant_admin OR membership exists.
   */
  it('tenant A CAN read own tenant record', async () => {
    const { data, error } = await clientA
      .from('tenants')
      .select('id, schema_name')
      .eq('id', TENANT_A.tenantId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(1);
    expect((data ?? [])[0]?.schema_name as string).toBe(TENANT_A.schemaName);
  });

  /**
   * Tenant A must be able to read their own membership row.
   */
  it('tenant A CAN read own tenant_memberships row', async () => {
    const { data, error } = await clientA
      .from('tenant_memberships')
      .select('tenant_id, user_id, role')
      .eq('user_id', TENANT_A.userId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  /**
   * Tenant A must be able to read their own subscription.
   */
  it('tenant A CAN read own subscription', async () => {
    const { data, error } = await clientA
      .from('subscriptions')
      .select('id, status')
      .eq('tenant_id', TENANT_A.tenantId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});

describeRls('RLS Isolation — Cross-tenant isolation in public schema', () => {
  /**
   * Tenant A memberships query must return ONLY tenant A's own membership.
   * "memberships: read own tenants" policy uses auth.uid() = user_id, which
   * naturally scopes the result to the authenticated user — never another user.
   */
  it('tenant A sees only own membership rows — never tenant B membership', async () => {
    const { data, error } = await clientA.from('tenant_memberships').select('tenant_id, user_id');
    expect(error).toBeNull();
    const rows = data ?? [];
    // Every returned row must belong to tenant A's user
    for (const row of rows) {
      expect(row.user_id).toBe(TENANT_A.userId);
    }
    // Must not expose tenant B's membership
    const hasTenantBMembership = rows.some((r) => r.tenant_id === TENANT_B.tenantId);
    expect(hasTenantBMembership).toBe(false);
  });

  /**
   * Tenant B memberships query must return ONLY tenant B's own membership.
   */
  it('tenant B sees only own membership rows — never tenant A membership', async () => {
    const { data, error } = await clientB.from('tenant_memberships').select('tenant_id, user_id');
    expect(error).toBeNull();
    const rows = data ?? [];
    for (const row of rows) {
      expect(row.user_id).toBe(TENANT_B.userId);
    }
    const hasTenantAMembership = rows.some((r) => r.tenant_id === TENANT_A.tenantId);
    expect(hasTenantAMembership).toBe(false);
  });

  /**
   * Tenant A must not see tenant B's tenant row.
   * Direct ID lookup should return 0 rows due to RLS.
   */
  it('tenant A cannot SELECT tenant B record from public.tenants by ID', async () => {
    const { data, error } = await clientA.from('tenants').select('id').eq('id', TENANT_B.tenantId);
    expect(error).toBeNull();
    // RLS should filter this to 0 rows — tenant A is not a member of tenant B
    expect((data ?? []).length).toBe(0);
  });

  /**
   * Tenant B must not see tenant A's tenant row.
   */
  it('tenant B cannot SELECT tenant A record from public.tenants by ID', async () => {
    const { data, error } = await clientB.from('tenants').select('id').eq('id', TENANT_A.tenantId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(0);
  });

  /**
   * Tenant A must not see tenant B's subscription.
   * "subscriptions: read own" policy checks membership via subquery.
   */
  it('tenant A cannot SELECT tenant B subscription from public.subscriptions', async () => {
    const { data } = await clientA
      .from('subscriptions')
      .select('id')
      .eq('tenant_id', TENANT_B.tenantId);
    expect((data ?? []).length).toBe(0);
  });

  /**
   * Tenant B must not see tenant A's subscription.
   */
  it('tenant B cannot SELECT tenant A subscription from public.subscriptions', async () => {
    const { data } = await clientB
      .from('subscriptions')
      .select('id')
      .eq('tenant_id', TENANT_A.tenantId);
    expect((data ?? []).length).toBe(0);
  });
});

describeRls('RLS Isolation — User isolation in public.recent_entities', () => {
  /**
   * public.recent_entities uses "own read" policy: user_id = auth.uid().
   * Tenant A user must not see tenant B user's recent_entities rows.
   *
   * This table uses user_id (not tenant_id) for scoping — a user who belongs
   * to multiple tenants sees only their own rows across all tenants.
   */
  it('tenant A user cannot see tenant B user recent_entities rows', async () => {
    const { data, error } = await clientA
      .from('recent_entities')
      .select('id, user_id')
      .eq('entity_id', SEED_RECENT_B_ID);
    expect(error).toBeNull();
    // The seed row belongs to tenant B user — tenant A must get 0 rows
    expect((data ?? []).length).toBe(0);
  });

  /**
   * Tenant B user must be able to read their own recent_entities row.
   * This verifies the policy allows own-user reads (sanity check).
   */
  it('tenant B user CAN read own recent_entities row', async () => {
    const { data, error } = await clientB
      .from('recent_entities')
      .select('id, user_id, entity_id')
      .eq('entity_id', SEED_RECENT_B_ID);
    expect(error).toBeNull();
    // The seed row was inserted by tenant B user — must be visible to them
    expect((data ?? []).length).toBeGreaterThan(0);
    expect((data ?? [])[0]?.user_id as string).toBe(TENANT_B.userId);
  });

  /**
   * Tenant A cannot INSERT a recent_entities row claiming tenant B's user_id.
   * WITH CHECK (user_id = auth.uid()) prevents this.
   */
  it('tenant A cannot INSERT recent_entities with tenant B user_id', async () => {
    const { error } = await clientA.from('recent_entities').insert({
      tenant_id: TENANT_A.tenantId,
      user_id: TENANT_B.userId, // attempting to spoof tenant B's user
      entity_type: 'company',
      entity_id: 'rls-spoofed-user-insert',
      display_name: 'Spoofed',
      entity_data: {},
    });
    expect(error).not.toBeNull();
  });
});

describeRls('RLS Isolation — Admin-only and blocked tables', () => {
  /**
   * support_questions is restricted to service_role only.
   * "support_questions: deny authenticated" uses USING(false) for authenticated role.
   * Tenant B is a tenant_member (not admin) — must be blocked.
   */
  it('authenticated non-admin user cannot SELECT from public.support_questions', async () => {
    const { data, error } = await clientB.from('support_questions').select('id');
    const blocked = (data ?? []).length === 0 || error !== null;
    expect(blocked).toBe(true);
  });

  /**
   * bbr_tracked_objects uses USING(false) — denies all direct access.
   * This table is service_role-only for background sync jobs.
   */
  it('authenticated user cannot SELECT from public.bbr_tracked_objects (deny-all policy)', async () => {
    const { data, error } = await clientB.from('bbr_tracked_objects').select('id');
    const blocked = (data ?? []).length === 0 || error !== null;
    expect(blocked).toBe(true);
  });

  /**
   * search_cache uses USING(false) — denies all direct access.
   */
  it('authenticated user cannot SELECT from public.search_cache (deny-all policy)', async () => {
    const { data, error } = await clientB.from('search_cache').select('id');
    const blocked = (data ?? []).length === 0 || error !== null;
    expect(blocked).toBe(true);
  });

  /**
   * plans are publicly readable — authenticated users must also see them.
   * This verifies the public policy works for authenticated users too.
   */
  it('non-admin authenticated user CAN read public.plans', async () => {
    const { data, error } = await clientB.from('plans').select('id, name');
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describeRls('RLS Isolation — Structural isolation: per-tenant schemas not exposed', () => {
  /**
   * Per-tenant schemas (tenant_jakob_dev, tenant_rls_test_b) are NOT exposed
   * via PostgREST. Supabase only exposes the `public` schema by default.
   * Attempting to switch schemas via the JS client returns a "Invalid schema"
   * error — this is the first line of structural defence before RLS even applies.
   *
   * This test documents this architecture invariant so any configuration
   * change that accidentally exposes tenant schemas is caught immediately.
   */
  it('JS client cannot access tenant_rls_test_b schema via PostgREST (schema not exposed)', async () => {
    // The .schema() method sends Accept-Profile header to PostgREST
    // PostgREST responds with PGRST106 "Invalid schema" for unexposed schemas
    const { error } = await clientA
      .schema(TENANT_B.schemaName as 'public')
      .from('saved_entities')
      .select('id');
    // Must always error — if it doesn't, the tenant schema is exposed (security issue!)
    expect(error).not.toBeNull();
    if (error) {
      // PGRST106 = "Invalid schema" — schema not in PostgREST exposed list
      // This is the expected structural isolation mechanism
      expect(error.code).toBe('PGRST106');
    }
  });

  /**
   * Same structural check for tenant A schema — not exposed via PostgREST.
   */
  it('JS client cannot access tenant_jakob_dev schema via PostgREST (schema not exposed)', async () => {
    const { error } = await clientB
      .schema(TENANT_A.schemaName as 'public')
      .from('saved_entities')
      .select('id');
    expect(error).not.toBeNull();
    if (error) {
      expect(error.code).toBe('PGRST106');
    }
  });
});

describeRls('RLS Isolation — Service role bypass (documented intentional behaviour)', () => {
  /**
   * The service role key intentionally bypasses ALL RLS policies.
   * This is documented Supabase behaviour — required for background jobs,
   * tenant provisioning, and cron tasks that need cross-tenant access.
   *
   * This test DOCUMENTS and verifies this intentional design.
   * The service role key is Restricted-classified data (ISO 27001 A.9)
   * and must never be exposed to clients or logged.
   *
   * @see lib/supabase/admin.ts — admin client usage and security warnings
   */
  it('service role CAN read all tenants (RLS bypass — expected for admin operations)', async () => {
    const { data, error } = await adminClient.from('tenants').select('id, schema_name');
    expect(error).toBeNull();
    const schemas = (data ?? []).map((r) => r.schema_name as string);
    expect(schemas).toContain(TENANT_A.schemaName);
    expect(schemas).toContain(TENANT_B.schemaName);
  });

  /**
   * Service role can read tenant B's subscription even without a membership.
   * Required for billing/cron operations that run outside user sessions.
   */
  it('service role CAN read tenant B subscription (RLS bypass — expected)', async () => {
    const { data, error } = await adminClient
      .from('subscriptions')
      .select('id, tenant_id')
      .eq('tenant_id', TENANT_B.tenantId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  /**
   * Service role can read all users — needed for auth/provisioning operations.
   */
  it('service role CAN read all memberships (RLS bypass — expected)', async () => {
    const { data, error } = await adminClient
      .from('tenant_memberships')
      .select('tenant_id, user_id');
    expect(error).toBeNull();
    // Must see both tenant A and tenant B memberships
    const tenantIds = (data ?? []).map((r) => r.tenant_id as string);
    expect(tenantIds).toContain(TENANT_A.tenantId);
    expect(tenantIds).toContain(TENANT_B.tenantId);
  });
});
