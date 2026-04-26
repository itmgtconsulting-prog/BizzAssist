/**
 * BIZZ-720: Domain-scoped AI gate.
 *
 * Complements the user-scoped assertAiAllowed (aiGate.ts) with a domain-
 * level check: does the domain have budget left for this generation?
 * domain.ai_tokens_used_current_period is bumped by the
 * domain_increment_ai_tokens RPC after every generation (migration 059).
 * When usage exceeds domain.limits.max_tokens_per_month, we block further
 * generations and return a 429.
 *
 * Call this BEFORE hitting Claude:
 *
 *   const blocked = await assertDomainAiAllowed(domainId);
 *   if (blocked) return blocked;
 *
 * @module app/lib/domainAiGate
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** Sentinel for "unlimited" in domain.limits.max_tokens_per_month. */
const UNLIMITED_TOKENS_SENTINEL = -1;

/**
 * Assert that the domain has room under its monthly AI-token cap. Returns
 * null when the caller may proceed, or a Response the caller should return
 * unchanged when the cap is exceeded.
 *
 * @param domainId - Validated domain UUID (e.g. from assertDomainMember)
 */
export async function assertDomainAiAllowed(domainId: string): Promise<Response | null> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('domain')
    .select('status, limits, ai_tokens_used_current_period')
    .eq('id', domainId)
    .maybeSingle();

  if (error) {
    logger.warn('[domainAiGate] fetch failed:', error.message);
    // Fail-closed: better to block than accidentally allow infinite spend
    return Response.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
  if (!data) return Response.json({ error: 'Domain not found' }, { status: 404 });

  const row = data as {
    status: string;
    limits: Record<string, number>;
    ai_tokens_used_current_period: number;
  };
  if (row.status !== 'active') {
    return Response.json(
      { error: 'Domain is not active — AI generation disabled' },
      { status: 403 }
    );
  }

  const cap = Number(row.limits?.max_tokens_per_month ?? 0);
  const used = Number(row.ai_tokens_used_current_period ?? 0);
  if (cap === UNLIMITED_TOKENS_SENTINEL) return null; // unlimited
  if (cap <= 0) {
    return Response.json(
      {
        error: 'Domain har ingen AI-tokens tildelt. Kontakt support.',
        code: 'domain_no_budget',
      },
      { status: 403 }
    );
  }
  if (used >= cap) {
    return Response.json(
      {
        error: 'Månedlig AI-token-grænse for domainet er nået. Kontakt support for at øge kvoten.',
        code: 'domain_quota_exceeded',
        used,
        cap,
      },
      { status: 429 }
    );
  }
  return null;
}
