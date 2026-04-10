/**
 * Supabase admin client — lib/supabase/admin.ts
 *
 * ⚠️  RESTRICTED — SERVER-SIDE ONLY. NEVER import in Client Components.
 *
 * Uses the SERVICE_ROLE_KEY which bypasses ALL Row Level Security policies.
 * Only use for:
 *   - Tenant provisioning (creating new tenant schemas on signup)
 *   - Background jobs / cron tasks
 *   - Admin-only operations that cannot be done with the anon key
 *
 * ISO 27001 A.9 (Access Control) + A.14 (Secure Development):
 *   The service role key is Restricted-classified data. It must never be
 *   logged, exposed in error messages, or sent to the client.
 *
 * BIZZ-104 (Connection pooling): The Supabase JS client communicates via
 * HTTP/REST (PostgREST) — not direct TCP port 5432. There is therefore no
 * PgBouncer pooling requirement for this client. However, creating a new
 * SupabaseClient instance on every request wastes memory and GC pressure
 * under high concurrency (250+ concurrent users). This module holds a
 * module-level singleton so the same client object is reused across all
 * requests within a Node.js worker process.
 *
 * Usage (server-side only):
 *   import { createAdminClient } from '@/lib/supabase/admin'
 *   const supabase = createAdminClient()
 *   await supabase.from('tenants').insert({ ... })
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PostgrestClient } from '@supabase/postgrest-js';

import type { Database } from '@/lib/supabase/types';

// ---------------------------------------------------------------------------
// Module-level singleton (BIZZ-104)
// ---------------------------------------------------------------------------

/**
 * Singleton instance of the admin client. Initialised lazily on first call
 * to createAdminClient() and reused for every subsequent call within the
 * same Node.js worker process.
 *
 * Why a singleton is safe here:
 *  - The admin client is stateless: autoRefreshToken and persistSession are
 *    both disabled, so it holds no per-user session state.
 *  - @supabase/supabase-js uses fetch() under the hood — each query opens its
 *    own HTTP request. The client object itself is just configuration wrapper.
 *  - Re-creating the object on every request (48+ call-sites × N concurrent
 *    requests) causes unnecessary GC pressure with no benefit.
 */
let _adminClient: SupabaseClient<Database> | null = null;

/**
 * Returns the module-level singleton Supabase admin client.
 *
 * The client uses the SERVICE_ROLE_KEY which bypasses ALL Row Level Security
 * policies. Bypasses RLS — use with extreme caution and always verify tenant
 * membership before making queries.
 *
 * Auto-refresh and session persistence are disabled (stateless server use).
 * The singleton is safe to share across concurrent requests because the
 * Supabase JS client is stateless — it holds no per-request or per-user data.
 *
 * @returns Supabase admin client with full database access
 * @throws If NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set
 */
export function createAdminClient(): SupabaseClient<Database> {
  // Return cached singleton if already initialised
  if (_adminClient !== null) {
    return _adminClient;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not set. ' + 'Add it to .env.local (never commit this value).'
    );
  }

  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. ' +
        'This is required for admin operations. ' +
        'Add it to .env.local (never commit this value).'
    );
  }

  _adminClient = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      // Disable session persistence — admin client is stateless.
      // This is what makes the singleton safe: no user session is cached here.
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _adminClient;
}

// ---------------------------------------------------------------------------
// Typed helpers for cross-schema (tenant-scoped) queries
// ---------------------------------------------------------------------------

/**
 * The return type of `.schema()` on the admin client when targeting a
 * per-tenant schema. TypeScript cannot express dynamic schema names (e.g.
 * `tenant_abc123`), so we use the `tenant` key defined in the `Database` type
 * as a representative shape, then cast the actual runtime string at call time.
 *
 * We use PostgrestClient directly with explicit schema generics to ensure
 * the type system resolves table types from TenantSchemaShape correctly,
 * rather than using ReturnType which loses the generic parameter binding.
 *
 * This type alias lets callers annotate `db` parameters without `any`.
 */
export type TenantDb = PostgrestClient<
  Database,
  { PostgrestVersion: '12' },
  'tenant',
  Database['tenant']
>;

/**
 * Returns a PostgREST client scoped to a specific tenant's PostgreSQL schema.
 *
 * Under the hood this calls `.schema(schemaName)` on the admin client, which
 * returns a typed PostgREST client. Because the Database type uses `tenant`
 * as a representative key for all per-tenant schemas, we cast the schema name
 * to `'tenant'` — the runtime value is the real schema name (e.g.
 * `tenant_abc123`), which Supabase/PostgREST forwards as the
 * `Accept-Profile` header.
 *
 * @param schemaName - The actual PostgreSQL schema name (e.g. `tenant_abc123`)
 * @returns Typed PostgREST client scoped to the given schema
 */
export function tenantDb(schemaName: string): TenantDb {
  const admin = createAdminClient();
  // We cast the schema name to 'tenant' so the compiler treats the result
  // as typed against our TenantSchemaShape rather than falling back to `any`.
  // The runtime value is the real dynamic schema name.
  return admin.schema(schemaName as 'tenant');
}
