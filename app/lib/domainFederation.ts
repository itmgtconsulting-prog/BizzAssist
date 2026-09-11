/**
 * Domain-federation helper (ADR-0011 / BIZZ-2192, subtask 2192.1).
 *
 * Returns the set of tenant `schema_name`s a user may READ under the per-user-
 * tenant + domain-federation model: the user's OWN tenant(s) ∪ all CURRENT
 * co-domain-members' tenant(s).
 *
 * Computed at query time with NO caching, so a change in `domain_member` (a
 * member joining or being removed) takes effect immediately — revocation is
 * free: the federation set simply shrinks and the data is personal again.
 *
 * This module is purely additive: it does NOT change any read path yet. The
 * read-path wiring (analyse list/[id]/geo/eksport, documents, sager, bibliotek)
 * lands in the follow-up subtasks (2192.2–2192.5), each behind this helper so
 * there is a single, testable federation boundary.
 *
 * @module app/lib/domainFederation
 */
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Minimal shape of the Supabase admin client this helper needs. Kept loose so
 * unit tests can inject a fake without a live DB. Each query builder is
 * thenable (awaiting it yields `{ data, error }`).
 */
export interface FederationDbClient {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => Promise<{ data: unknown[] | null; error: unknown }>;
      in: (col: string, vals: string[]) => Promise<{ data: unknown[] | null; error: unknown }>;
    };
  };
}

/** A tenant_memberships row with the embedded tenant schema_name. */
interface MembershipRow {
  tenants?: { schema_name?: string | null } | { schema_name?: string | null }[] | null;
}

/**
 * Resolves the tenant schema_names readable by `userId` via domain federation.
 *
 * @param userId - Authenticated Supabase user id (from resolveTenantId/session — never from user input)
 * @param client - Optional injected admin client (for tests); defaults to createAdminClient()
 * @returns Sorted, de-duplicated list of tenant schema_names (own + co-domain-members'). Always includes the user's own tenant(s); empty only if the user has no tenant at all.
 */
export async function getDomainLinkedTenants(
  userId: string,
  client?: FederationDbClient
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: FederationDbClient = client ?? (createAdminClient() as any);

  // 1. Domains the user is a member of.
  const { data: myDomains } = await admin
    .from('domain_member')
    .select('domain_id')
    .eq('user_id', userId);
  const domainIds = ((myDomains ?? []) as { domain_id: string }[])
    .map((d) => d.domain_id)
    .filter(Boolean);

  // 2. All users in those domains (co-members) — always include the user itself
  //    so a non-domain user still resolves to their own tenant.
  const memberUserIds = new Set<string>([userId]);
  if (domainIds.length > 0) {
    const { data: coMembers } = await admin
      .from('domain_member')
      .select('user_id')
      .in('domain_id', domainIds);
    for (const m of (coMembers ?? []) as { user_id: string }[]) {
      if (m.user_id) memberUserIds.add(m.user_id);
    }
  }

  // 3. Resolve tenant schema_names for those users (own ∪ co-members').
  const { data: memberships } = await admin
    .from('tenant_memberships')
    .select('tenants(schema_name)')
    .in('user_id', [...memberUserIds]);

  const schemas = new Set<string>();
  for (const m of (memberships ?? []) as MembershipRow[]) {
    const t = m.tenants;
    if (!t) continue;
    // PostgREST may embed the to-one relation as an object or a single-element array.
    const rows = Array.isArray(t) ? t : [t];
    for (const r of rows) {
      if (r?.schema_name) schemas.add(r.schema_name);
    }
  }
  return [...schemas].sort();
}
