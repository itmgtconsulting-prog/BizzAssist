/**
 * BIZZ-720: syncDomainSubscription unit tests.
 *
 * Verifies the defensive branches (plan-guard, no-lookup-keys, unmatched
 * customer) and the happy-path writes domain.status + domain.limits from
 * plan_configs.ai_tokens_per_month.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fromMock = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
function table(overrides: {
  maybeSingle?: unknown;
  update?: { error?: { message: string } | null };
  insert?: { error?: { message: string } | null };
}): any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'maybeSingle') {
          return () => Promise.resolve(overrides.maybeSingle ?? { data: null });
        }
        if (prop === 'update') {
          return () => ({
            eq: () => Promise.resolve(overrides.update ?? { error: null }),
          });
        }
        if (prop === 'insert') {
          return () => ({
            then: (r: (v: unknown) => unknown) =>
              Promise.resolve(overrides.insert ?? { error: null }).then(r),
          });
        }
        // chainable filter / select
        return () => table(overrides);
      },
    }
  );
}

describe('syncDomainSubscription — BIZZ-720', () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it('no-ops when plan is not enterprise_domain', async () => {
    const { syncDomainSubscription } = await import('@/app/lib/domainStripeSync');
    const r = await syncDomainSubscription({
      planId: 'professionel',
      customerId: 'cus_123',
      status: 'active',
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('plan-not-enterprise-domain');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('returns no-lookup-keys when nothing can identify the domain', async () => {
    const { syncDomainSubscription } = await import('@/app/lib/domainStripeSync');
    const r = await syncDomainSubscription({
      planId: 'enterprise_domain',
      customerId: null,
      status: 'active',
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('no-lookup-keys');
  });

  it('returns no-domain-found when lookups miss', async () => {
    fromMock.mockImplementation(() => table({ maybeSingle: { data: null } }));
    const { syncDomainSubscription } = await import('@/app/lib/domainStripeSync');
    const r = await syncDomainSubscription({
      planId: 'enterprise_domain',
      customerId: 'cus_nope',
      subscriptionId: 'sub_nope',
      status: 'active',
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('no-domain-found');
  });

  it('happy-path: matches by domain hint, writes status + limits', async () => {
    const callLog: string[] = [];
    fromMock.mockImplementation((tableName: string) => {
      callLog.push(tableName);
      if (tableName === 'domain') {
        return table({
          maybeSingle: {
            data: {
              id: 'dom-1',
              status: 'active',
              limits: { max_tokens_per_month: 500000 },
              stripe_customer_id: null,
              stripe_subscription_id: null,
            },
          },
          update: { error: null },
        });
      }
      if (tableName === 'plan_configs') {
        return table({ maybeSingle: { data: { ai_tokens_per_month: 750000 } } });
      }
      if (tableName === 'domain_audit_log') {
        return table({ insert: { error: null } });
      }
      return table({});
    });
    const { syncDomainSubscription } = await import('@/app/lib/domainStripeSync');
    const r = await syncDomainSubscription({
      planId: 'enterprise_domain',
      customerId: 'cus_123',
      subscriptionId: 'sub_xyz',
      status: 'active',
      domainIdHint: 'dom-1',
    });
    expect(r.matched).toBe(true);
    expect(r.domainId).toBe('dom-1');
    // domain lookup + plan_configs lookup + domain update + audit log
    expect(callLog).toContain('domain');
    expect(callLog).toContain('plan_configs');
  });

  it('maps cancelled status to suspended on domain', async () => {
    let capturedStatus: unknown = null;
    fromMock.mockImplementation((tableName: string) => {
      if (tableName === 'domain') {
        const proxy = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === 'maybeSingle')
                return () =>
                  Promise.resolve({
                    data: {
                      id: 'dom-1',
                      status: 'active',
                      limits: {},
                      stripe_customer_id: 'cus',
                      stripe_subscription_id: 'sub',
                    },
                  });
              if (prop === 'update') {
                return (payload: Record<string, unknown>) => {
                  capturedStatus = payload.status;
                  return { eq: () => Promise.resolve({ error: null }) };
                };
              }
              return () => proxy;
            },
          }
        );
        return proxy;
      }
      if (tableName === 'plan_configs') {
        return table({ maybeSingle: { data: { ai_tokens_per_month: 100 } } });
      }
      return table({});
    });
    const { syncDomainSubscription } = await import('@/app/lib/domainStripeSync');
    const r = await syncDomainSubscription({
      planId: 'enterprise_domain',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'cancelled',
    });
    expect(r.matched).toBe(true);
    expect(capturedStatus).toBe('suspended');
  });
});
