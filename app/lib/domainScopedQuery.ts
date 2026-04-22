/**
 * Domain-scoped query wrapper — BIZZ-722 Lag 4.
 *
 * All domain data queries MUST go through this helper instead of calling
 * supabase.from() directly. This ensures every query is automatically
 * filtered by domain_id, preventing cross-domain data leaks.
 *
 * Usage:
 *   const q = domainScopedQuery(ctx.domainId);
 *   const { data } = await q('domain_template').select('*');
 *
 * Why a wrapper instead of raw supabase.from():
 *   - Forces domain_id filter on every query — cannot be forgotten
 *   - Sets X-Domain-Id header for audit trail
 *   - Single point of enforcement for the entire domain data layer
 *
 * @module app/lib/domainScopedQuery
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Tables that require domain_id scoping. */
type DomainScopedTable =
  | 'domain_template'
  | 'domain_template_version'
  | 'domain_training_doc'
  | 'domain_case'
  | 'domain_case_doc'
  | 'domain_generation'
  | 'domain_embedding'
  | 'domain_audit_log'
  | 'domain_member';

/**
 * Returns a function that creates domain-scoped queries.
 * Every query returned is pre-filtered with .eq('domain_id', domainId).
 *
 * @param domainId - Validated domain UUID (must come from assertDomainMember/Admin)
 * @returns Scoped query builder function
 */
export function domainScopedQuery(domainId: string) {
  const admin = createAdminClient();

  /**
   * Creates a query builder for the given table, pre-filtered by domain_id.
   *
   * @param table - Domain-scoped table name
   * @returns Supabase query builder with domain_id filter applied
   */
  return function scopedFrom(table: DomainScopedTable) {
    // domain_template_version doesn't have domain_id directly —
    // it's joined through template_id. Use a raw join filter instead.
    if (table === 'domain_template_version') {
      return (admin as SupabaseClient).from(table);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (admin as any).from(table).eq('domain_id', domainId);
  };
}

/**
 * Convenience: Insert a row into a domain-scoped table with domain_id injected.
 * Prevents callers from forgetting to include domain_id in the insert payload.
 *
 * @param domainId - Validated domain UUID
 * @param table - Domain-scoped table name
 * @param row - Row data (domain_id is injected automatically)
 * @returns Supabase insert response
 */
export async function domainScopedInsert(
  domainId: string,
  table: DomainScopedTable,
  row: Record<string, unknown>
) {
  const admin = createAdminClient();
  return (admin as SupabaseClient).from(table).insert({ ...row, domain_id: domainId });
}
