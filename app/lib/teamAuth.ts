/**
 * Team-management authorization helpers.
 *
 * BIZZ-271: /api/team/* routes skal tjekke at caller er tenant_admin i
 * den samme tenant som target-user før operations udføres. Disse helpers
 * centraliserer check-logikken så vi undgår subtile auth-huller.
 *
 * @module app/lib/teamAuth
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { resolveTenantId, type AuthContext } from '@/lib/api/auth';

export interface TeamAuthContext extends AuthContext {
  role: 'tenant_admin' | 'tenant_member' | 'tenant_viewer';
}

/**
 * Hent authenticated user's tenant + role i tenant_memberships.
 * Returnerer null hvis ikke logget ind eller ingen tenant-membership.
 */
export async function resolveTeamContext(): Promise<TeamAuthContext | null> {
  const base = await resolveTenantId();
  if (!base) return null;

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = (await (admin as any)
    .from('tenant_memberships')
    .select('role')
    .eq('tenant_id', base.tenantId)
    .eq('user_id', base.userId)
    .maybeSingle()) as {
    data: { role: 'tenant_admin' | 'tenant_member' | 'tenant_viewer' } | null;
  };
  if (!data) return null;
  return { ...base, role: data.role };
}

/**
 * Kræver at caller er tenant_admin. Returnerer null hvis ikke.
 */
export async function requireTenantAdmin(): Promise<TeamAuthContext | null> {
  const ctx = await resolveTeamContext();
  if (!ctx || ctx.role !== 'tenant_admin') return null;
  return ctx;
}

/**
 * Generer cryptografisk stærk invitation-token. 256 bits som base64url
 * giver 43 chars — kort nok til at fit i URL, lang nok til at være
 * uforudsigelig.
 */
export function generateInvitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url uden padding
  return Buffer.from(bytes)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
