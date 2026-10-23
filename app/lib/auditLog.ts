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
 * `public.audit_log` table exists — so every audit write failed silently.
 * Compounding it, callers invoke these helpers fire-and-forget (not awaited),
 * so on Vercel's serverless runtime the insert was abandoned when the function
 * froze after the response. Both are fixed: writes target the correct schema
 * AND run inside `after()`, which Vercel keeps alive past the response.
 *
 * Never throws; insert failures are logged (no PII) but do not break the
 * main operation.
 *
 * @module app/lib/auditLog
 */

import { after } from 'next/server';
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
 * @returns Parsed object (or a wrapper) for a jsonb column, or null
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
 * Schedule an audit-write promise so it reliably completes.
 *
 * Callers invoke the audit helpers fire-and-forget. On Vercel's serverless
 * runtime the function can freeze once the response is sent, abandoning any
 * un-awaited work. `after()` registers the promise so the platform keeps the
 * invocation alive until it settles. Outside a request context (where
 * `after()` is unavailable) the promise still runs — it is started eagerly.
 *
 * @param work - The already-started audit-write promise
 * @returns The same promise (so awaiting callers can still await it)
 */
function schedule(work: Promise<void>): Promise<void> {
  const guarded = work.catch((e: unknown) =>
    logger.error('[audit] Failed to insert audit log:', e)
  );
  try {
    after(() => guarded);
  } catch {
    /* ikke i request-kontekst — promisen kører alligevel (startet eager) */
  }
  return guarded;
}

/**
 * Resolve a tenant's PostgreSQL schema name via the admin client (service-role,
 * no session cookies). Returns null if the tenant is unknown.
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

/** Core tenant-audit insert (awaitable; no scheduling). */
async function insertTenantAudit(
  tenantId: string,
  entry: AuditEntry,
  userId: string | null
): Promise<void> {
  const schemaName = await resolveSchema(tenantId);
  if (!schemaName) return;
  // Best-effort: resolve the acting user from the session when not supplied
  // (the column is nullable). Mirrors the proven tenant-context audit writer.
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
    logger.error('[AUDIT LOG FAILURE]', error.message, entry.action);
  }
}

/** Core system-audit insert (awaitable; no scheduling). */
async function insertSystemAudit(entry: AuditEntry): Promise<void> {
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
}

/**
 * Writes a tenant-scoped audit entry into the tenant's OWN `audit_log`.
 * Reliable fire-and-forget (runs inside `after()`); never throws.
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
  return schedule(insertTenantAudit(tenantId, entry, userId));
}

/**
 * Writes a tenant-scoped audit entry, resolving the tenant from a user UUID.
 * For routes that authenticate via `supabase.auth.getUser()` and hold no tenant
 * id. Reliable fire-and-forget (runs inside `after()`); never throws.
 *
 * @param userId - Acting user UUID
 * @param entry - Audit fields
 */
export async function writeAuditLogByUser(userId: string, entry: AuditEntry): Promise<void> {
  return schedule(
    (async () => {
      const admin = createAdminClient();
      // Deterministic tenant selection (oldest membership) — mirrors
      // resolveTenantId() so audit lands in the schema the route writes to.
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
      await insertTenantAudit(data.tenant_id, entry, userId);
    })()
  );
}

/**
 * Writes a system-level audit entry (no single tenant) to
 * `public.system_audit_log` — e.g. Stripe webhooks, super-admin service
 * management, bootstrap, anonymous consent, support-ticket creation.
 * Reliable fire-and-forget (runs inside `after()`); never throws.
 *
 * @param entry - Audit fields
 */
export async function writeSystemAuditLog(entry: AuditEntry): Promise<void> {
  return schedule(insertSystemAudit(entry));
}
