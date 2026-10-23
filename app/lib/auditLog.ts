/**
 * Shared audit-log helpers — used by API routes that perform write operations.
 *
 * ISO 27001 A.12.4 / BIZZ-289 / BIZZ-2293: all security-relevant events must be
 * logged. Audit rows live in each tenant's OWN PostgreSQL schema
 * (`tenant_<x>.audit_log`). System-level events with no single tenant (Stripe
 * webhooks, super-admin service management, bootstrap, anonymous consent) go to
 * `public.system_audit_log`.
 *
 * History (BIZZ-2293/2297): this module previously did
 * `admin.from('audit_log').insert(...)` against the public schema, but no
 * `public.audit_log` table exists — so every audit write failed silently and
 * no event was ever recorded. It now resolves the tenant schema (admin client,
 * no session cookies required) and checks the insert error.
 *
 * Fire-and-forget — never throws; failures are logged (no PII) but do not break
 * the main operation.
 *
 * @module app/lib/auditLog
 */

import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/app/lib/logger';

/** One audit event. `metadata` is a JSON-serialised string (parsed to jsonb on write). */
export interface AuditEntry {
  /** Action identifier — "resource.verb" (e.g. "notification.mark_read") */
  action: string;
  /** Resource type (e.g. "notification", "conversation", "link") */
  resource_type: string;
  /** Resource identifier */
  resource_id: string;
  /** JSON-serialised metadata with additional context */
  metadata?: string;
}

/**
 * Parse a JSON metadata string into an object for the jsonb column. Absent or
 * invalid JSON degrades gracefully (never throws).
 *
 * @param metadata - JSON string, or undefined
 * @returns Parsed object (or a wrapper) suitable for a jsonb column, or null
 */
function parseMetadata(metadata?: string): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw: metadata };
  }
}

/**
 * Resolve a tenant's PostgreSQL schema name via the admin client. Uses the
 * service-role client (no session cookies) so it works in fire-and-forget
 * contexts. Returns null if the tenant is unknown.
 *
 * @param tenantId - Verified tenant UUID (never derived from raw user input)
 * @returns The tenant schema name (e.g. `tenant_abc123`) or null
 */
async function resolveSchema(tenantId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('tenants')
    .select('schema_name')
    .eq('id', tenantId)
    .maybeSingle<{ schema_name: string }>();
  if (error || !data?.schema_name) {
    logger.error('[audit] kunne ikke slå tenant-skema op');
    return null;
  }
  return data.schema_name;
}

/**
 * Writes a tenant-scoped audit entry into the tenant's OWN `audit_log` table.
 * Fire-and-forget — never throws; errors are logged (no PII).
 *
 * @param tenantId - Verified tenant UUID (from the auth session, never raw input)
 * @param entry - Audit fields
 * @param userId - Optional acting user UUID (stored as `user_id`)
 */
export async function writeAuditLog(
  tenantId: string,
  entry: AuditEntry,
  userId: string | null = null
): Promise<void> {
  try {
    const schemaName = await resolveSchema(tenantId);
    if (!schemaName) return;
    // Best-effort: resolve the acting user from the session when the caller did
    // not supply one (the column is nullable). Mirrors the proven
    // tenant-context audit writer. In a torn-down fire-and-forget context the
    // session read may fail — we tolerate that and leave user_id null.
    let actingUserId = userId;
    if (actingUserId === null) {
      try {
        const supabase = await createServerClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        actingUserId = user?.id ?? null;
      } catch {
        /* ingen session-kontekst — user_id forbliver null */
      }
    }
    const { error } = await tenantDb(schemaName)
      .from('audit_log')
      .insert({
        tenant_id: tenantId,
        user_id: actingUserId,
        action: entry.action,
        resource_type: entry.resource_type,
        resource_id: entry.resource_id ?? null,
        metadata: parseMetadata(entry.metadata),
      });
    if (error) {
      // Audit failures must not be silently swallowed, but must not throw.
      logger.error('[AUDIT LOG FAILURE]', error.message, entry.action);
    }
  } catch (e: unknown) {
    logger.error('[audit] Failed to insert audit log:', e);
  }
}

/**
 * Writes a tenant-scoped audit entry, resolving the tenant from a user UUID.
 * For routes that authenticate via `supabase.auth.getUser()` and do not hold a
 * tenant id in scope. Fire-and-forget — never throws.
 *
 * @param userId - Acting user UUID
 * @param entry - Audit fields
 */
export async function writeAuditLogByUser(userId: string, entry: AuditEntry): Promise<void> {
  try {
    const admin = createAdminClient();
    // Deterministic tenant selection (oldest membership) — mirrors
    // resolveTenantId() so audit lands in the same schema the route writes to.
    const { data, error } = await admin
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle<{ tenant_id: string }>();
    if (error || !data?.tenant_id) {
      logger.error('[audit] kunne ikke slå tenant op for bruger');
      return;
    }
    await writeAuditLog(data.tenant_id, entry, userId);
  } catch (e: unknown) {
    logger.error('[audit] Failed to insert audit log (by user):', e);
  }
}

/**
 * Writes a system-level audit entry (no single tenant) to
 * `public.system_audit_log` — e.g. Stripe webhooks, super-admin service
 * management, bootstrap, anonymous consent, support-ticket creation.
 * Fire-and-forget — never throws.
 *
 * @param entry - Audit fields
 */
export async function writeSystemAuditLog(entry: AuditEntry): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('system_audit_log').insert({
      action: entry.action,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id ?? null,
      metadata: parseMetadata(entry.metadata),
    });
    if (error) {
      logger.error('[SYSTEM AUDIT FAILURE]', error.message, entry.action);
    }
  } catch (e: unknown) {
    logger.error('[audit] Failed to insert system audit log:', e);
  }
}
