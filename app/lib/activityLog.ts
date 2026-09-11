/**
 * activityLog — server-side helper for logging user events to Supabase.
 *
 * Fire-and-forget design: the insert is never awaited, so logging never
 * blocks or delays the primary API response. Errors are swallowed silently
 * so a logging failure can never surface to the user.
 *
 * GDPR / ISO 27001:
 *  - No PII in payload — no names, email addresses, or free-text queries.
 *  - Retention: 12 months (enforced by /api/cron/purge-old-data).
 *  - Data is tenant-scoped via tenant_id + user_id for cascade delete.
 *
 * @module app/lib/activityLog
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** All event categories that can be written to activity_log */
export type ActivityEventType =
  | 'address_search'
  | 'ai_chat'
  | 'page_view'
  | 'property_open'
  | 'company_open'
  | 'owner_open';

/**
 * Logs a user activity event to the tenant.activity_log table.
 *
 * This is a fire-and-forget call — it does NOT block the caller.
 * Never surfaces errors to the user; all failures are silently swallowed.
 *
 * activity_log lives in the per-tenant `tenant_<slug>` schema (BIZZ-2288). The
 * shared `tenant` schema is NOT exposed to PostgREST, so the previous
 * `.schema('tenant')` write failed with PGRST106 and silently logged nothing.
 * We resolve the tenant's schema name from public.tenants and write there.
 *
 * @param supabase  - Supabase admin client (service role) with full schema access
 * @param tenantId  - Tenant UUID — must come from a validated auth session, never user input
 * @param userId    - User UUID — must come from a validated auth session, never user input
 * @param eventType - Event category (e.g. 'address_search', 'ai_chat')
 * @param payload   - Arbitrary JSON metadata; must contain NO PII (no names, emails, IPs)
 */
export function logActivity(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  eventType: ActivityEventType,
  payload: Record<string, unknown> = {}
): void {
  // Fire-and-forget: intentionally not awaited.
  // Supabase's .schema() builder returns a PromiseLike (not a full Promise), so we
  // wrap in an async IIFE to safely suppress errors without blocking the caller.
  void (async () => {
    try {
      // Resolve the per-tenant schema name (the shared 'tenant' schema is not
      // PostgREST-exposed — writing there fails with PGRST106).
      const { data: tenant } = await supabase
        .from('tenants')
        .select('schema_name')
        .eq('id', tenantId)
        .single();
      const schemaName = (tenant as { schema_name?: string } | null)?.schema_name;
      if (!schemaName) return;

      await supabase
        .schema(schemaName as 'tenant')
        .from('activity_log')
        .insert({ tenant_id: tenantId, user_id: userId, event_type: eventType, payload });
    } catch {
      // Intentionally swallowed — logging failures must never surface to users (ISO 27001 A.12.4)
    }
  })();
}
