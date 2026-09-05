/**
 * BIZZ-2192.1: Unit tests for the domain-federation helper (ADR-0011).
 *
 * Verifies the query-time federation set (own tenant ∪ current co-domain-
 * members' tenants) with an injected fake Supabase client — no live DB. These
 * tests are the guard for the isolation-critical read-path wiring in the
 * follow-up subtasks: the federation boundary must be exactly own+co-members,
 * never wider.
 */
import { describe, it, expect } from 'vitest';
import { getDomainLinkedTenants, type FederationDbClient } from '@/app/lib/domainFederation';

/**
 * Builds a fake FederationDbClient from canned tables.
 *
 * @param data - { domain_member: rows, tenant_memberships: rows }
 */
function fakeClient(data: {
  domainMember: { domain_id: string; user_id: string }[];
  tenantMemberships: { user_id: string; schema_name: string }[];
}): FederationDbClient {
  return {
    from(table: string) {
      return {
        select() {
          return {
            // domain_member.select('domain_id').eq('user_id', userId)
            async eq(_col: string, val: string) {
              if (table === 'domain_member') {
                return {
                  data: data.domainMember
                    .filter((r) => r.user_id === val)
                    .map((r) => ({ domain_id: r.domain_id })),
                  error: null,
                };
              }
              return { data: [], error: null };
            },
            async in(col: string, vals: string[]) {
              if (table === 'domain_member') {
                // .select('user_id').in('domain_id', domainIds)
                return {
                  data: data.domainMember
                    .filter((r) => vals.includes(r.domain_id))
                    .map((r) => ({ user_id: r.user_id })),
                  error: null,
                };
              }
              if (table === 'tenant_memberships') {
                // .select('tenants(schema_name)').in('user_id', memberUserIds)
                return {
                  data: data.tenantMemberships
                    .filter((r) => vals.includes(r.user_id))
                    .map((r) => ({ tenants: { schema_name: r.schema_name } })),
                  error: null,
                };
              }
              return { data: [], error: null };
            },
          };
        },
      };
    },
  };
}

describe('getDomainLinkedTenants', () => {
  it('non-domain user resolves to only their own tenant', async () => {
    const client = fakeClient({
      domainMember: [],
      tenantMemberships: [{ user_id: 'u1', schema_name: 'tenant_u1' }],
    });
    expect(await getDomainLinkedTenants('u1', client)).toEqual(['tenant_u1']);
  });

  it('co-domain members federate each others tenants', async () => {
    const client = fakeClient({
      domainMember: [
        { domain_id: 'd1', user_id: 'u1' },
        { domain_id: 'd1', user_id: 'u2' },
      ],
      tenantMemberships: [
        { user_id: 'u1', schema_name: 'tenant_u1' },
        { user_id: 'u2', schema_name: 'tenant_u2' },
      ],
    });
    expect(await getDomainLinkedTenants('u1', client)).toEqual(['tenant_u1', 'tenant_u2']);
  });

  it('does NOT leak tenants of users outside the shared domain', async () => {
    const client = fakeClient({
      domainMember: [
        { domain_id: 'd1', user_id: 'u1' },
        { domain_id: 'd1', user_id: 'u2' },
        // u3 is in a DIFFERENT domain — must not be federated to u1
        { domain_id: 'd2', user_id: 'u3' },
      ],
      tenantMemberships: [
        { user_id: 'u1', schema_name: 'tenant_u1' },
        { user_id: 'u2', schema_name: 'tenant_u2' },
        { user_id: 'u3', schema_name: 'tenant_u3' },
      ],
    });
    const result = await getDomainLinkedTenants('u1', client);
    expect(result).toEqual(['tenant_u1', 'tenant_u2']);
    expect(result).not.toContain('tenant_u3');
  });

  it('revocation shrinks the federation immediately (u2 removed from domain)', async () => {
    // u2 no longer in d1 → u1 sees only own tenant again (query-time, no cache)
    const client = fakeClient({
      domainMember: [{ domain_id: 'd1', user_id: 'u1' }],
      tenantMemberships: [
        { user_id: 'u1', schema_name: 'tenant_u1' },
        { user_id: 'u2', schema_name: 'tenant_u2' },
      ],
    });
    expect(await getDomainLinkedTenants('u1', client)).toEqual(['tenant_u1']);
  });

  it('de-duplicates and sorts when a co-member shares a tenant', async () => {
    const client = fakeClient({
      domainMember: [
        { domain_id: 'd1', user_id: 'u1' },
        { domain_id: 'd1', user_id: 'u2' },
      ],
      tenantMemberships: [
        { user_id: 'u1', schema_name: 'tenant_shared' },
        { user_id: 'u2', schema_name: 'tenant_shared' },
        { user_id: 'u2', schema_name: 'tenant_u2' },
      ],
    });
    expect(await getDomainLinkedTenants('u1', client)).toEqual(['tenant_shared', 'tenant_u2']);
  });

  it('member of multiple domains federates across all of them', async () => {
    const client = fakeClient({
      domainMember: [
        { domain_id: 'd1', user_id: 'u1' },
        { domain_id: 'd1', user_id: 'u2' },
        { domain_id: 'd2', user_id: 'u1' },
        { domain_id: 'd2', user_id: 'u4' },
      ],
      tenantMemberships: [
        { user_id: 'u1', schema_name: 'tenant_u1' },
        { user_id: 'u2', schema_name: 'tenant_u2' },
        { user_id: 'u4', schema_name: 'tenant_u4' },
      ],
    });
    expect(await getDomainLinkedTenants('u1', client)).toEqual([
      'tenant_u1',
      'tenant_u2',
      'tenant_u4',
    ]);
  });
});
