/**
 * BIZZ-2271/2243: tenantUserDb — RLS-enforced tenant read path.
 *
 * tenantUserDb(userClient, schema) scopes the USER-JWT client to a tenant schema so
 * queries run as the `authenticated` role and RLS (is_tenant_member(auth.uid()))
 * gates them — the defense-in-depth backstop. This test locks the contract that it
 * delegates to the user client's .schema() (NOT the service_role admin client).
 *
 * The end-to-end RLS behaviour (member sees rows, non-member sees 0, service_role
 * bypasses) is verified separately against dev via SQL role-simulation (see ticket).
 */
import { describe, it, expect, vi } from 'vitest';
import { tenantUserDb } from '@/lib/db/tenant';

describe('BIZZ-2271 tenantUserDb', () => {
  it('scoper bruger-klienten til det angivne tenant-schema via .schema()', () => {
    const scoped = { from: vi.fn() };
    const schemaSpy = vi.fn().mockReturnValue(scoped);
    const userClient = { schema: schemaSpy } as never;

    const db = tenantUserDb(userClient, 'tenant_abc123');

    expect(schemaSpy).toHaveBeenCalledWith('tenant_abc123');
    expect(db).toBe(scoped);
  });

  it('videregiver det dynamiske schema-navn uændret (ingen hardcoded tenant)', () => {
    const schemaSpy = vi.fn().mockReturnValue({});
    const userClient = { schema: schemaSpy } as never;
    tenantUserDb(userClient, 'tenant_jjrchefen_gmail_com');
    expect(schemaSpy).toHaveBeenCalledWith('tenant_jjrchefen_gmail_com');
  });
});
