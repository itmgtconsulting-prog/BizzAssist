/**
 * Shared audit log helper — used by all API routes that perform write operations.
 *
 * Inserts a row into the public audit_log table. Fire-and-forget — errors are
 * logged but never re-thrown, so audit failures don't break the main operation.
 *
 * ISO 27001 A.12.4: All security-relevant events must be logged.
 * BIZZ-289: Centralized audit logging for all write operations.
 *
 * @module app/lib/auditLog
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

interface AuditEntry {
  /** Action identifier — use "resource.verb" format (e.g. "notification.mark_read") */
  action: string;
  /** Resource type (e.g. "notification", "conversation", "link") */
  resource_type: string;
  /** Resource identifier (e.g. notification ID, conversation ID) */
  resource_id: string;
  /** JSON-serialized metadata with additional context */
  metadata?: string;
}

/**
 * Writes an audit log entry. Fire-and-forget — never throws.
 *
 * @param entry - Audit log fields
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from('audit_log').insert(entry);
  } catch (e: unknown) {
    logger.error('[audit] Failed to insert audit log:', e);
  }
}
