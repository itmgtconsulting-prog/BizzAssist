/**
 * BIZZ-649 P0: Central AI billing-gate delt mellem alle Anthropic-ramte
 * endpoints.
 *
 * Historik: Tidligere lå gate-logikken kun i `/api/ai/chat/route.ts`, så de
 * 7 andre AI-endpoints (`article-search`, `person-search/*`,
 * `person-article-search`, `analysis/run`, `support/chat`) bypassede
 * quota-checket helt. En trial-bruger kunne derfor kalde Anthropic via fx
 * `/api/analysis/run` uden at blive blokeret. Dette er den direkte
 * billing-lækage BIZZ-649 beskriver.
 *
 * Denne fil eksponerer `assertAiAllowed(userId)` som returnerer enten
 *   - `null` → gate tillader kaldet, handler kan fortsætte til Anthropic
 *   - `Response` → gate blokerer, handler skal returnere Response direkte
 *
 * Politik (BIZZ-649):
 *  1. Admin-brugere (`app_metadata.isAdmin === true`) bypasser altid
 *     gate — internt team skal kunne teste AI uden plan-config.
 *  2. `ai_tokens_per_month === -1` betyder "unlimited" (dokumenteret i
 *     subscriptions.ts:55 + AIChatPanel.tsx:319). Gate skal returnere
 *     `allow` uden quota-check for disse planer.
 *  3. Øvrig logik delegeres til den rene `decideAiGate()`-funktion i
 *     `/api/ai/chat/route.ts` så der kun er ét sandt "decision tree".
 *
 * @module app/lib/aiGate
 */

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase/admin';
import { decideAiGate } from '@/app/api/ai/chat/route';
import { logger } from '@/app/lib/logger';

/**
 * Subscription-snapshot som vi læser fra `auth.users.app_metadata.subscription`.
 * Alle felter er optional for backwards-compat med gamle user-metadata uden
 * BIZZ-643 per-kilde-tracking.
 */
interface SubscriptionSnapshot {
  status?: string;
  planId?: string;
  tokensUsedThisMonth?: number;
  bonusTokens?: number;
  topUpTokens?: number;
}

/**
 * Sentinel-værdi for unlimited-plan (fx enterprise).
 *
 * Når `plan_configs.ai_tokens_per_month === UNLIMITED_TOKENS_SENTINEL` skal
 * gate altid returnere `allow`. Konventionen er dokumenteret i flere filer
 * (`app/lib/subscriptions.ts:55`, `app/components/AIChatPanel.tsx:319`) og
 * centraliseres her for DRY.
 */
export const UNLIMITED_TOKENS_SENTINEL = -1;

/**
 * Verificerer om en authenticated bruger må kalde Anthropic-baserede AI-
 * endpoints. Skal kaldes som første led i enhver route-handler der kan
 * ramme Anthropic (efter `resolveTenantId()`).
 *
 * @param userId - Supabase auth user-id fra `resolveTenantId()`
 * @returns `null` hvis tilladt, `Response` hvis blokeret (handler skal returnere direkte)
 *
 * @example
 * const auth = await resolveTenantId();
 * if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });
 * const blocked = await assertAiAllowed(auth.userId);
 * if (blocked) return blocked;
 * // ... Anthropic-kald
 */
export async function assertAiAllowed(userId: string): Promise<Response | null> {
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  // Læs frisk user-metadata direkte — undgå at stole på JWT-claims der kan
  // være stale efter plan-skift eller admin-toggle.
  const { data: userData, error: userErr } = await admin.auth.admin.getUserById(userId);
  if (userErr || !userData?.user) {
    logger.warn('[aiGate] getUserById fejlede for userId', { userId });
    return Response.json({ error: 'Aktivt abonnement kræves for at bruge AI' }, { status: 403 });
  }

  const meta = (userData.user.app_metadata ?? {}) as Record<string, unknown>;
  const isAdmin = meta.isAdmin === true;
  const sub = (meta.subscription ?? {}) as SubscriptionSnapshot;

  // BIZZ-649 politik 1: Admin-brugere bypasser gate. Internt team skal
  // kunne bruge AI til support/test uden at have aktiv plan.
  if (isAdmin) {
    return null;
  }

  // Resolve plan-tokens fra plan_configs. Trial-brugere får 0 plan-tokens
  // (per BIZZ-641) — de må kun bruge bonus + topUp.
  const subStatus = sub.status ?? '';
  let planTokens = 0;
  if (sub.planId) {
    const { data: planRow } = await admin
      .from('plan_configs')
      .select('ai_tokens_per_month')
      .eq('plan_id', sub.planId)
      .single<{ ai_tokens_per_month: number }>();
    const rawPlanTokens = planRow?.ai_tokens_per_month ?? 0;

    // BIZZ-649 politik 2: -1 = unlimited (dokumenteret konvention).
    // Returnér allow med det samme — ingen quota-check for unlimited-planer.
    if (rawPlanTokens === UNLIMITED_TOKENS_SENTINEL) {
      return null;
    }

    planTokens = subStatus === 'trialing' ? 0 : rawPlanTokens;
  }

  const bonusTokens = sub.bonusTokens ?? 0;
  const topUpTokens = sub.topUpTokens ?? 0;
  const tokensUsedThisMonth = sub.tokensUsedThisMonth ?? 0;

  // Delegér den rene decision-logik til decideAiGate (fælles med
  // /api/ai/chat så ingen divergens i beslutnings-træet).
  const gate = decideAiGate({
    status: subStatus,
    tokensUsedThisMonth,
    planTokens,
    bonusTokens,
    topUpTokens,
  });

  if (gate.decision === 'allow') {
    return null;
  }

  if (gate.decision === 'no_subscription') {
    return Response.json(
      { error: 'Aktivt abonnement kræves for at bruge AI-assistenten' },
      { status: 403 }
    );
  }

  if (gate.decision === 'quota_exceeded') {
    return Response.json({ error: 'Token kvote opbrugt for denne måned' }, { status: 429 });
  }

  // gate.decision === 'zero_budget' — plan=0 + bonus=0 + topUp=0.
  // Sentry-breadcrumb så vi kan audite forsøg på bypass i produktion.
  Sentry.addBreadcrumb({
    category: 'billing',
    message: 'AI blocked: zero_budget',
    level: 'info',
    data: { isTrial: gate.isTrial, userId, planId: sub.planId ?? null },
  });
  return Response.json(
    {
      error: gate.isTrial
        ? 'AI-tokens er låst indtil dit abonnement starter. Køb en token-pakke for at bruge AI nu.'
        : 'Dit abonnement har ingen AI-tokens. Køb en token-pakke eller opgrader plan for at bruge AI.',
      code: 'trial_ai_blocked',
      cta: 'buy_token_pack',
    },
    { status: 402 }
  );
}
