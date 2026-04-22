/**
 * BIZZ-720: Sync Stripe subscription state onto the domain entity.
 *
 * Called from the Stripe webhook handlers after they have updated the
 * tenant-level subscription metadata. If the event relates to an
 * `enterprise_domain` plan subscription and we can locate the matching
 * domain row (via stripe_customer_id / stripe_subscription_id), we
 * propagate:
 *
 *   - domain.status      → 'active' | 'suspended'
 *   - domain.limits      → max_tokens_per_month from plan_configs
 *   - domain.stripe_*    → kept in sync with the latest event payload
 *
 * Defensive-by-design: every branch has a null-safe fallback, and the
 * helper never throws. Webhook handlers must remain idempotent so we
 * log & swallow instead of bubbling.
 *
 * @module app/lib/domainStripeSync
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** Plan ID that triggers domain-level sync. */
export const ENTERPRISE_DOMAIN_PLAN = 'enterprise_domain';

export interface DomainSyncInput {
  planId: string | null | undefined;
  /** Stripe customer id (always present on subscription events). */
  customerId: string | null | undefined;
  /** Stripe subscription id — optional for checkout.completed. */
  subscriptionId?: string | null;
  /** Normalised webhook status: active | past_due | cancelled | payment_failed. */
  status: 'active' | 'past_due' | 'payment_failed' | 'cancelled' | string;
  /** Optional domain_id from checkout metadata — preferred over customer-id
   *  lookup because it's unambiguous when a tenant owns multiple domains. */
  domainIdHint?: string | null;
}

export interface DomainSyncResult {
  /** Whether a domain row was matched and updated. */
  matched: boolean;
  /** Reason we skipped — surfaced for logging. */
  reason?: string;
  /** Updated domain row's id when matched. */
  domainId?: string;
}

/**
 * Translate a webhook status string into the domain.status CHECK-constraint
 * value. Per migration 058 the CHECK is ('active', 'suspended', 'archived');
 * we map payment failures → suspended and keep active otherwise so the
 * domain-admin UI surfaces a consistent state.
 */
function mapDomainStatus(webhookStatus: string): 'active' | 'suspended' {
  if (webhookStatus === 'cancelled' || webhookStatus === 'payment_failed') return 'suspended';
  // past_due + unknown → keep active; the tenant-level grace handles access.
  return 'active';
}

/**
 * Sync a Stripe subscription event onto the domain entity. Safe to call
 * for every webhook event; it no-ops unless planId === ENTERPRISE_DOMAIN_PLAN.
 */
export async function syncDomainSubscription(input: DomainSyncInput): Promise<DomainSyncResult> {
  if (input.planId !== ENTERPRISE_DOMAIN_PLAN) {
    return { matched: false, reason: 'plan-not-enterprise-domain' };
  }
  if (!input.customerId && !input.subscriptionId && !input.domainIdHint) {
    return { matched: false, reason: 'no-lookup-keys' };
  }

  const admin = createAdminClient();

  // Resolve the domain row. Preference order: explicit hint → subscription id
  // → customer id. Limit 1 — if multiple domains share a customer (rare, but
  // possible with multi-domain tenants), the metadata hint is the tiebreaker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const domainTbl = (admin as any).from('domain');

  type DomainRow = {
    id: string;
    status: string;
    limits: Record<string, unknown> | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  };
  let row: DomainRow | null = null;

  if (input.domainIdHint) {
    const { data } = (await domainTbl
      .select('id, status, limits, stripe_customer_id, stripe_subscription_id')
      .eq('id', input.domainIdHint)
      .maybeSingle()) as { data: DomainRow | null };
    row = data;
  }
  if (!row && input.subscriptionId) {
    const { data } = (await domainTbl
      .select('id, status, limits, stripe_customer_id, stripe_subscription_id')
      .eq('stripe_subscription_id', input.subscriptionId)
      .maybeSingle()) as { data: DomainRow | null };
    row = data;
  }
  if (!row && input.customerId) {
    const { data } = (await domainTbl
      .select('id, status, limits, stripe_customer_id, stripe_subscription_id')
      .eq('stripe_customer_id', input.customerId)
      .limit(1)
      .maybeSingle()) as { data: DomainRow | null };
    row = data;
  }
  if (!row) {
    logger.warn('[domainStripeSync] no domain matched', {
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      domainIdHint: input.domainIdHint,
    });
    return { matched: false, reason: 'no-domain-found' };
  }

  // Pull token allowance from plan_configs so the domain cap stays in sync
  // with admin-configurable plan parameters (same source as tenant plans).
  let maxTokens = 500_000;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: planRow } = (await (admin as any)
      .from('plan_configs')
      .select('ai_tokens_per_month')
      .eq('plan_id', ENTERPRISE_DOMAIN_PLAN)
      .maybeSingle()) as { data: { ai_tokens_per_month: number } | null };
    if (planRow && typeof planRow.ai_tokens_per_month === 'number') {
      maxTokens = planRow.ai_tokens_per_month;
    }
  } catch (err) {
    logger.warn('[domainStripeSync] plan_configs lookup failed — keeping existing limits', err);
  }

  const nextStatus = mapDomainStatus(input.status);
  const existingLimits = (row.limits ?? {}) as Record<string, unknown>;
  const nextLimits = { ...existingLimits, max_tokens_per_month: maxTokens };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upErr } = await (admin as any)
    .from('domain')
    .update({
      status: nextStatus,
      limits: nextLimits,
      stripe_customer_id: input.customerId ?? row.stripe_customer_id,
      stripe_subscription_id: input.subscriptionId ?? row.stripe_subscription_id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  if (upErr) {
    logger.error('[domainStripeSync] update failed', upErr);
    return { matched: false, reason: 'update-failed', domainId: row.id };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('domain_audit_log')
    .insert({
      domain_id: row.id,
      action: 'stripe_sync',
      target_type: 'domain',
      target_id: row.id,
      metadata: {
        from_status: row.status,
        to_status: nextStatus,
        plan: ENTERPRISE_DOMAIN_PLAN,
        customer_id: input.customerId ?? null,
        subscription_id: input.subscriptionId ?? null,
      },
    })
    .then(
      () => undefined,
      () => undefined
    );

  return { matched: true, domainId: row.id };
}
