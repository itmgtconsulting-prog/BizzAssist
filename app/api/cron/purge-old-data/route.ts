/**
 * Nightly data retention enforcement cron job — /api/cron/purge-old-data
 *
 * Purges user data older than configured retention periods across all tenant schemas:
 *   - recent_entities: purge rows with visited_at older than 12 months
 *   - notifications:   purge read notifications (is_read = true) older than 6 months
 *   - ai_token_usage:  purge rows older than 13 months (GDPR — BIZZ-172)
 *
 * Also purges global (public-schema) caches:
 *   - regnskab_cache:  purge rows older than 90 days (BIZZ-172)
 *
 * Additionally purges full tenant data for tenants closed more than 30 days ago
 * (i.e. public.tenants.closed_at IS NOT NULL AND closed_at < NOW() - 30 days).
 *
 * Writes a summary row to each affected tenant's audit_log and returns a JSON summary.
 *
 * Security:
 *   - Requires Authorization: Bearer <CRON_SECRET> header
 *   - In Vercel production also requires x-vercel-cron: 1 header
 *   - Uses admin client (service_role) — no user session
 *
 * Schedule: 0 3 * * * (3am nightly, configured in vercel.json)
 *
 * @module api/cron/purge-old-data
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';

// ── Types ────────────────────────────────────────────────────────────────────

/** Per-tenant purge result logged to audit_log and returned in the response. */
interface TenantPurgeResult {
  tenantId: string;
  schemaName: string;
  recentEntitiesDeleted: number;
  notificationsDeleted: number;
  aiConversationsDeleted: number;
  recentSearchesDeleted: number;
  activityLogDeleted: number;
  aiTokenUsageDeleted: number;
  error?: string;
}

/** Shape of a row from public.tenants */
interface TenantRow {
  id: string;
  schema_name: string;
  closed_at: string | null;
}

/** PostgREST error shape returned by tenant schema queries */
interface TenantQueryError {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
}

/**
 * Awaitable query chain for tenant schema tables.
 * Mirrors PostgrestQueryBuilder structurally without using `any`.
 * Tenant schemas are not in the generated Database types.
 */
type TenantQuery = PromiseLike<{
  data: Record<string, unknown>[] | null;
  error: TenantQueryError | null;
  count: number | null;
}> & {
  select(
    cols?: string,
    opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }
  ): TenantQuery;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): TenantQuery;
  update(values: Record<string, unknown>): TenantQuery;
  delete(opts?: { count?: 'exact' | 'planned' | 'estimated' }): TenantQuery;
  eq(col: string, val: unknown): TenantQuery;
  neq(col: string, val: unknown): TenantQuery;
  gt(col: string, val: unknown): TenantQuery;
  gte(col: string, val: unknown): TenantQuery;
  lt(col: string, val: unknown): TenantQuery;
  lte(col: string, val: unknown): TenantQuery;
  in(col: string, vals: unknown[]): TenantQuery;
  is(col: string, val: unknown): TenantQuery;
  not(col: string, op: string, val: unknown): TenantQuery;
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): TenantQuery;
  limit(n: number): TenantQuery;
  range(from: number, to: number): TenantQuery;
  single(): PromiseLike<{ data: Record<string, unknown> | null; error: TenantQueryError | null }>;
};

/**
 * Typed helper for schema-switched Supabase operations.
 * The Supabase JS client's .schema() method returns a client typed to the
 * dynamic tenant schema, but generated types only cover public. We cast to
 * this interface using TenantQuery to avoid `any`.
 */
interface SchemaClient {
  from: (table: string) => TenantQuery;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Verifies the incoming request carries a valid CRON_SECRET bearer token.
 * In Vercel production, also enforces the x-vercel-cron: 1 header to prevent
 * external callers from triggering the job.
 *
 * @param request - Incoming Next.js request
 * @returns true if authorised, false otherwise
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a schema-switched client for the given tenant schema.
 * The returned client is cast to SchemaClient to allow untyped .from() calls
 * against tenant-schema tables (which are not in the generated Supabase types).
 *
 * @param admin      - Supabase admin client
 * @param schemaName - Tenant schema name (e.g. "tenant_abc123")
 * @returns Untyped schema-switched query client
 */
function tenantDb(admin: ReturnType<typeof createAdminClient>, schemaName: string): SchemaClient {
  return (admin as unknown as { schema: (s: string) => SchemaClient }).schema(schemaName);
}

/**
 * Writes a single audit log row to the given tenant schema's audit_log table.
 * Fire-and-forget — errors are logged but do not abort the purge.
 *
 * @param admin      - Supabase admin client
 * @param schemaName - Tenant schema name (e.g. "tenant_abc123")
 * @param tenantId   - Tenant UUID (stored in audit_log.tenant_id)
 * @param metadata   - Arbitrary metadata object to store
 */
async function writeAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  schemaName: string,
  tenantId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    const db = tenantDb(admin, schemaName);
    await db.from('audit_log').insert({
      tenant_id: tenantId,
      user_id: null, // system action — no user session
      action: 'cron.purge_old_data',
      resource_type: 'retention',
      resource_id: null,
      metadata,
    });
  } catch (err) {
    logger.error(`[purge-old-data] audit_log write failed for ${schemaName}:`, err);
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * GET /api/cron/purge-old-data
 *
 * Iterates all tenants in public.tenants and for each active tenant schema:
 *   1. Deletes recent_entities rows older than 12 months (by visited_at).
 *      recent_entities uses visited_at (not created_at) as its primary timestamp.
 *   2. Deletes read notifications older than 6 months (is_read = true, by created_at).
 *   3. Deletes recent_searches rows older than 12 months (BIZZ-133 — GDPR Art. 5(1)(e)).
 *   4. Deletes activity_log rows older than 12 months (BIZZ-133 — GDPR Art. 5(1)(e)).
 *   5. Deletes ai_token_usage rows older than 13 months (BIZZ-172 — GDPR retention).
 *
 * For closed tenants (closed_at IS NOT NULL AND closed_at < NOW() - 30 days):
 *   - Deletes ALL rows in recent_entities, notifications, saved_entities,
 *     property_snapshots, recent_searches, and activity_log within that tenant
 *     schema to fulfil post-closure GDPR erasure.
 *
 * Additionally purges the global public-schema cache:
 *   - regnskab_cache rows older than 90 days (BIZZ-172).
 *
 * Returns a JSON summary of rows deleted per tenant.
 *
 * @param request - Incoming Next.js request (must carry CRON_SECRET bearer token)
 * @returns JSON summary { ok, tenants: TenantPurgeResult[], totalErrors, regnskabCacheDeleted }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  // Fetch all tenant rows — we need schema_name and closed_at
  const { data: tenants, error: tenantErr } = (await admin
    .from('tenants')
    .select('id, schema_name, closed_at')) as {
    data: TenantRow[] | null;
    error: unknown;
  };

  if (tenantErr || !tenants) {
    logger.error('[purge-old-data] Failed to fetch tenants:', tenantErr);
    return NextResponse.json({ error: 'Failed to fetch tenants' }, { status: 500 });
  }

  const results: TenantPurgeResult[] = [];

  for (const tenant of tenants) {
    if (!tenant.schema_name) continue;

    const result: TenantPurgeResult = {
      tenantId: tenant.id,
      schemaName: tenant.schema_name,
      recentEntitiesDeleted: 0,
      notificationsDeleted: 0,
      aiConversationsDeleted: 0,
      recentSearchesDeleted: 0,
      activityLogDeleted: 0,
      aiTokenUsageDeleted: 0,
    };

    try {
      const db = tenantDb(admin, tenant.schema_name);

      const isClosedAndExpired =
        tenant.closed_at !== null &&
        new Date(tenant.closed_at) < new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      if (isClosedAndExpired) {
        // ── Post-closure GDPR purge: delete all personal data in this schema ──
        // Use { count: 'exact' } on delete to get row counts back.
        const { count: recentCount } = await db
          .from('recent_entities')
          .delete({ count: 'exact' })
          .not('id', 'is', null); // match all rows

        const { count: notifCount } = await db
          .from('notifications')
          .delete({ count: 'exact' })
          .not('id', 'is', null);

        // Also purge snapshots, saved_entities, ai_conversations, recent_searches,
        // and activity_log — no count needed for these (BIZZ-133: search history retention).
        await db.from('property_snapshots').delete().not('id', 'is', null);
        await db.from('saved_entities').delete().not('id', 'is', null);
        await db.from('ai_conversations').delete().not('id', 'is', null);
        await db.from('recent_searches').delete().not('id', 'is', null);
        await db.from('activity_log').delete().not('id', 'is', null);

        result.recentEntitiesDeleted = recentCount ?? 0;
        result.notificationsDeleted = notifCount ?? 0;

        await writeAuditLog(admin, tenant.schema_name, tenant.id, {
          event: 'post_closure_purge',
          recentEntitiesDeleted: result.recentEntitiesDeleted,
          notificationsDeleted: result.notificationsDeleted,
          closedAt: tenant.closed_at,
        });
      } else {
        // ── Regular TTL purge for active tenants ──

        // 1. recent_entities: purge rows older than 12 months (by visited_at).
        //    recent_entities uses visited_at as its primary timestamp column —
        //    there is no separate created_at column on this table.
        const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

        const { count: recentCount } = await db
          .from('recent_entities')
          .delete({ count: 'exact' })
          .lt('visited_at', twelveMonthsAgo);

        result.recentEntitiesDeleted = recentCount ?? 0;

        // 2. notifications: purge read notifications older than 6 months.
        //    Column name is is_read (boolean), not read.
        const sixMonthsAgo = new Date(Date.now() - 183 * 24 * 60 * 60 * 1000).toISOString();

        const { count: notifCount } = await db
          .from('notifications')
          .delete({ count: 'exact' })
          .eq('is_read', true)
          .lt('created_at', sixMonthsAgo);

        result.notificationsDeleted = notifCount ?? 0;

        // 3. ai_conversations: purge threads older than 12 months (GDPR storage limitation).
        //    Privacy policy states 12-month retention; this enforces it in practice.
        const { count: aiCount } = await db
          .from('ai_conversations')
          .delete({ count: 'exact' })
          .lt('updated_at', twelveMonthsAgo);

        result.aiConversationsDeleted = aiCount ?? 0;

        // 4. recent_searches: purge rows older than 12 months (BIZZ-133).
        //    GDPR Art. 5(1)(e) — storage limitation; search queries are personal data.
        //    Column used is created_at (set at insert time, never updated).
        const { count: searchCount } = await db
          .from('recent_searches')
          .delete({ count: 'exact' })
          .lt('created_at', twelveMonthsAgo);

        result.recentSearchesDeleted = searchCount ?? 0;

        // 5. activity_log: purge rows older than 12 months (BIZZ-133).
        //    Audit/activity entries older than 12 months are no longer required for
        //    operational purposes and must be purged under GDPR storage limitation.
        const { count: activityCount } = await db
          .from('activity_log')
          .delete({ count: 'exact' })
          .lt('created_at', twelveMonthsAgo);

        result.activityLogDeleted = activityCount ?? 0;

        // 6. ai_token_usage: purge rows older than 13 months (GDPR retention — BIZZ-172).
        //    Token usage records are personal data (linked to user_id); 13 months covers
        //    a full billing cycle before they must be erased.
        const thirteenMonthsAgo = new Date(
          Date.now() - (13 * 365.25 * 24 * 60 * 60 * 1000) / 12
        ).toISOString();

        const { count: tokenUsageCount } = await db
          .from('ai_token_usage')
          .delete({ count: 'exact' })
          .lt('created_at', thirteenMonthsAgo);

        result.aiTokenUsageDeleted = tokenUsageCount ?? 0;

        // Write audit log only if something was actually purged
        if (
          result.recentEntitiesDeleted > 0 ||
          result.notificationsDeleted > 0 ||
          result.aiConversationsDeleted > 0 ||
          result.recentSearchesDeleted > 0 ||
          result.activityLogDeleted > 0 ||
          result.aiTokenUsageDeleted > 0
        ) {
          await writeAuditLog(admin, tenant.schema_name, tenant.id, {
            event: 'ttl_purge',
            recentEntitiesDeleted: result.recentEntitiesDeleted,
            notificationsDeleted: result.notificationsDeleted,
            aiConversationsDeleted: result.aiConversationsDeleted,
            recentSearchesDeleted: result.recentSearchesDeleted,
            activityLogDeleted: result.activityLogDeleted,
            aiTokenUsageDeleted: result.aiTokenUsageDeleted,
          });
        }
      }
    } catch (err) {
      result.error = String(err);
      logger.error(`[purge-old-data] Error processing tenant ${tenant.schema_name}:`, err);
    }

    results.push(result);
  }

  const totalErrors = results.filter((r) => r.error !== undefined).length;

  // ── Global (public-schema) purges ──────────────────────────────────────────

  // Purge regnskab_cache rows older than 90 days (BIZZ-172).
  // This is a shared public-schema cache — not tenant-scoped — so it is
  // purged once here rather than inside the per-tenant loop.
  let regnskabCacheDeleted = 0;
  try {
    const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { count: cacheCount } = await admin
      .from('regnskab_cache')
      .delete({ count: 'exact' })
      .lt('fetched_at', cutoff90d);
    regnskabCacheDeleted = cacheCount ?? 0;
  } catch (err) {
    logger.error('[purge-old-data] Failed to purge regnskab_cache:', err);
  }

  return NextResponse.json({
    ok: true,
    tenants: results,
    totalErrors,
    regnskabCacheDeleted,
  });
}
