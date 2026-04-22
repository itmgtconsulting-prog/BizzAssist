/**
 * Domain auth helpers — resolve domain membership and enforce access control.
 *
 * BIZZ-700: Matches existing resolveTenantId() pattern but for domain-scope.
 * All domain API routes call resolveDomainId() at the top.
 *
 * @module app/lib/domainAuth
 */

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/** Resolved domain context */
export interface DomainContext {
  /** Domain UUID */
  domainId: string;
  /** Current user's role in this domain */
  role: 'admin' | 'member';
  /** Current user's Supabase user ID */
  userId: string;
}

/** Domain summary for navigation */
export interface DomainSummary {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'member';
}

/**
 * Resolves the current user's domain membership for a given domain ID.
 * Returns null if user is not authenticated or not a member.
 *
 * @param domainId - Domain UUID from URL params
 * @returns DomainContext or null
 */
export async function resolveDomainId(domainId: string): Promise<DomainContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: membership } = (await (admin as any)
    .from('domain_member')
    .select('role')
    .eq('domain_id', domainId)
    .eq('user_id', user.id)
    .maybeSingle()) as { data: { role: 'admin' | 'member' } | null };

  if (!membership) return null;

  return {
    domainId,
    role: membership.role,
    userId: user.id,
  };
}

/**
 * Asserts that the current user is an admin of the given domain.
 * Throws a 403-style error if not.
 *
 * @param domainId - Domain UUID
 * @returns DomainContext (guaranteed role='admin')
 * @throws Error with message 'Forbidden' if not admin
 */
export async function assertDomainAdmin(domainId: string): Promise<DomainContext> {
  const ctx = await resolveDomainId(domainId);
  if (!ctx || ctx.role !== 'admin') {
    throw new Error('Forbidden');
  }
  return ctx;
}

/**
 * Asserts that the current user is a member (admin or member) of the given domain.
 * Throws a 403-style error if not.
 *
 * @param domainId - Domain UUID
 * @returns DomainContext
 * @throws Error with message 'Forbidden' if not member
 */
export async function assertDomainMember(domainId: string): Promise<DomainContext> {
  const ctx = await resolveDomainId(domainId);
  if (!ctx) {
    throw new Error('Forbidden');
  }
  return ctx;
}

/**
 * Lists all domains the current user is a member of.
 * Used for the Domain navigation menu.
 *
 * @returns Array of DomainSummary, empty if not authenticated or no memberships
 */
export async function listUserDomains(): Promise<DomainSummary[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: memberships } = (await (admin as any)
    .from('domain_member')
    .select('role, domain:domain_id (id, name, slug)')
    .eq('user_id', user.id)) as {
    data: Array<{
      role: 'admin' | 'member';
      domain: { id: string; name: string; slug: string };
    }> | null;
  };

  if (!memberships) return [];

  return memberships
    .filter((m) => m.domain)
    .map((m) => ({
      id: m.domain.id,
      name: m.domain.name,
      slug: m.domain.slug,
      role: m.role,
    }));
}
