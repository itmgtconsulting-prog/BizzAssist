/**
 * User subscription API — GET /api/subscription
 *
 * Returns the current user's subscription from their Supabase app_metadata.
 * Uses the ADMIN client to read fresh data directly from the Auth database,
 * bypassing JWT caching issues where app_metadata set by admin isn't
 * reflected in the user's JWT until token refresh.
 *
 * This is the server-side source of truth for subscriptions — works across
 * all browsers unlike localStorage.
 */

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { stripe } from '@/app/lib/stripe';
import {
  resolvePlan,
  computeTokenRollover,
  getEffectiveTokenLimit,
  isSubscriptionFunctional,
  type PlanId,
  type PlanDef,
} from '@/app/lib/subscriptions';

/** Row shape from plan_configs table */
interface PlanConfigRow {
  plan_id: string;
  name_da: string;
  name_en: string;
  desc_da: string;
  desc_en: string;
  color: string;
  price_dkk: number;
  ai_tokens_per_month: number;
  duration_months: number;
  duration_days: number;
  token_accumulation_cap_multiplier: number;
  ai_enabled: boolean;
  requires_approval: boolean;
  is_active: boolean;
  free_trial_days: number;
  max_sales: number | null;
  sales_count: number;
}

/** Stripe billing details fetched for the current customer */
interface StripeBillingInfo {
  /** ISO date of next payment */
  nextPaymentDate: string | null;
  /** Last 4 digits of default payment method card */
  cardLast4: string | null;
  /** Card brand (visa, mastercard, etc.) */
  cardBrand: string | null;
  /** Whether cancel_at_period_end is set */
  cancelAtPeriodEnd: boolean;
  /** ISO date when subscription will be cancelled */
  cancelAt: string | null;
  /** Stripe subscription status */
  stripeStatus: string | null;
}

/**
 * Fetch billing details from Stripe for a given customer ID.
 * Returns null if Stripe is unavailable or no active subscription exists.
 *
 * @param customerId - Stripe customer ID
 * @returns StripeBillingInfo or null
 */
async function fetchStripeBilling(customerId: string): Promise<StripeBillingInfo | null> {
  if (!stripe) return null;
  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 10,
      expand: ['data.default_payment_method'],
    });

    // Prefer active subscriptions that are NOT set to cancel at period end.
    // A customer may have an old subscription cancelling + a new active one.
    const sub =
      subscriptions.data.find((s) => !s.cancel_at_period_end) ?? subscriptions.data[0] ?? null;

    if (!sub) return null;

    // Get period end from subscription item (Stripe v21+)
    const firstItem = sub.items?.data?.[0];
    const periodEndUnix = firstItem?.current_period_end ?? 0;
    const nextPaymentDate = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null;

    // Get card info from default payment method
    let cardLast4: string | null = null;
    let cardBrand: string | null = null;
    const pm = sub.default_payment_method;
    if (pm && typeof pm === 'object' && 'card' in pm) {
      const card = (pm as { card?: { last4?: string; brand?: string } }).card;
      cardLast4 = card?.last4 ?? null;
      cardBrand = card?.brand ?? null;
    }

    return {
      nextPaymentDate,
      cardLast4,
      cardBrand,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
      stripeStatus: sub.status,
    };
  } catch (err) {
    console.error('[subscription] Stripe billing fetch error:', err);
    return null;
  }
}

/**
 * GET /api/subscription — get the current user's subscription.
 *
 * Flow:
 *   1. Authenticate user via regular Supabase client (validates JWT)
 *   2. Use admin client to fetch fresh user data from Auth database
 *   3. Fetch Stripe billing details (next payment, card info)
 *   4. Return the subscription from fresh app_metadata enriched with billing data
 *
 * @returns JSON with subscription data or { subscription: null }
 */
export async function GET(): Promise<NextResponse> {
  try {
    // Step 1: Authenticate the caller via their JWT
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ subscription: null }, { status: 401 });
    }

    // Step 2: Use admin client to get FRESH user data from the Auth database.
    // This bypasses JWT caching — admin.auth.admin.getUserById reads directly
    // from the database, not from the JWT token.
    const admin = createAdminClient();
    const { data: freshUser, error } = await admin.auth.admin.getUserById(user.id);

    if (error || !freshUser?.user) {
      // Fallback to JWT data if admin lookup fails
      console.warn('[subscription] Admin getUserById failed, using JWT data:', error?.message);
      const subscription = user.app_metadata?.subscription ?? null;
      return NextResponse.json({
        email: user.email,
        fullName: (user.user_metadata?.full_name as string) ?? '',
        subscription,
      });
    }

    // Step 3: Return fresh data from database, with lazy token rollover
    const subscription = freshUser.user.app_metadata?.subscription as Record<
      string,
      unknown
    > | null;
    const fullName = (freshUser.user.user_metadata?.full_name as string) ?? '';
    const isAdmin = !!freshUser.user.app_metadata?.isAdmin;

    // Determine if user is email/password (not OAuth-only) for 2FA banner logic
    const providers =
      (freshUser.user.app_metadata?.providers as string[] | undefined) ??
      (freshUser.user.app_metadata?.provider
        ? [freshUser.user.app_metadata.provider as string]
        : []);
    const isEmailUser =
      providers.includes('email') ||
      (!providers.some((p) => ['azure', 'google', 'linkedin_oidc', 'github'].includes(p)) &&
        !!freshUser.user.email);

    // Check if user has a verified TOTP factor (for 2FA banner)
    let hasMfa = false;
    if (isEmailUser) {
      const { data: factorsData } = await (
        admin as ReturnType<typeof import('@supabase/supabase-js').createClient>
      )
        .from('auth.mfa_factors')
        .select('id')
        .eq('user_id', user.id)
        .eq('status', 'verified')
        .limit(1);
      hasMfa = Array.isArray(factorsData) && factorsData.length > 0;
      if (!hasMfa) {
        // Fallback: use admin MFA API
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: mfaData } = await (admin.auth.admin as any).mfa.listFactors({
            userId: user.id,
          });
          hasMfa = (mfaData?.factors ?? []).some(
            (f: { status: string; factor_type: string }) =>
              f.status === 'verified' && f.factor_type === 'totp'
          );
        } catch {
          hasMfa = false;
        }
      }
    }

    // Step 3b: Fetch plan definition from DB for the user's plan
    let resolvedPlan: PlanDef | null = null;
    if (subscription?.planId) {
      const { data: planRow } = (await admin
        .from('plan_configs')
        .select('*')
        .eq('plan_id', subscription.planId as string)
        .single()) as { data: PlanConfigRow | null };
      if (planRow) {
        resolvedPlan = {
          id: planRow.plan_id as PlanId,
          nameDa: planRow.name_da || (subscription.planId as string),
          nameEn: planRow.name_en || (subscription.planId as string),
          descDa: planRow.desc_da || '',
          descEn: planRow.desc_en || '',
          color: planRow.color || 'slate',
          priceDkk: planRow.price_dkk ?? 0,
          aiEnabled: planRow.ai_enabled ?? false,
          aiTokensPerMonth: planRow.ai_tokens_per_month ?? 0,
          requiresApproval: planRow.requires_approval ?? false,
          durationMonths: planRow.duration_months ?? 1,
          durationDays: planRow.duration_days ?? 0,
          tokenAccumulationCapMultiplier: planRow.token_accumulation_cap_multiplier ?? 5,
          freeTrialDays: planRow.free_trial_days ?? 0,
        };
      }
    }
    // Fallback to hardcoded/cached plan if DB lookup fails
    const plan =
      resolvedPlan ?? (subscription?.planId ? resolvePlan(subscription.planId as string) : null);

    // Build a typed sub object for helpers
    const typedSub = subscription
      ? {
          email: freshUser.user.email ?? '',
          planId: (subscription.planId as PlanId) ?? 'demo',
          status:
            (subscription.status as 'active' | 'pending' | 'cancelled' | 'expired') ?? 'pending',
          createdAt: (subscription.createdAt as string) ?? '',
          approvedAt: (subscription.approvedAt as string | null) ?? null,
          tokensUsedThisMonth: (subscription.tokensUsedThisMonth as number) ?? 0,
          periodStart: (subscription.periodStart as string) ?? '',
          accumulatedTokens: (subscription.accumulatedTokens as number) ?? 0,
          topUpTokens: (subscription.topUpTokens as number) ?? 0,
          bonusTokens: (subscription.bonusTokens as number) ?? 0,
          isPaid: (subscription.isPaid as boolean) ?? false,
        }
      : null;

    // Compute whether subscription is functional (paid / free / trial)
    // Admins always have full access regardless of payment status
    const isFunctional = isAdmin || isSubscriptionFunctional(typedSub, plan);

    // Step 4: Fetch Stripe billing details (next payment, card, cancellation)
    const stripeCustomerId = freshUser.user.app_metadata?.stripe_customer_id as string | undefined;
    const billing = stripeCustomerId ? await fetchStripeBilling(stripeCustomerId) : null;

    // Lazy token rollover: if the billing period has passed, accumulate unused tokens
    if (typedSub && plan && typedSub.periodStart && typedSub.status === 'active') {
      if (plan.aiTokensPerMonth > 0) {
        const rollover = computeTokenRollover(typedSub, plan);
        if (rollover) {
          const updatedSub = { ...subscription, ...rollover };
          await admin.auth.admin.updateUserById(user.id, {
            app_metadata: {
              ...freshUser.user.app_metadata,
              subscription: updatedSub,
            },
          });
          const effectiveLimit = getEffectiveTokenLimit({ ...typedSub, ...rollover }, plan);
          return NextResponse.json({
            email: freshUser.user.email,
            fullName,
            subscription: updatedSub,
            effectiveTokenLimit: effectiveLimit,
            plan: plan
              ? {
                  id: plan.id,
                  nameDa: plan.nameDa,
                  nameEn: plan.nameEn,
                  priceDkk: plan.priceDkk,
                  freeTrialDays: plan.freeTrialDays,
                }
              : null,
            isFunctional,
            isAdmin,
            billing,
          });
        }

        const effectiveLimit = getEffectiveTokenLimit(typedSub, plan);
        return NextResponse.json({
          email: freshUser.user.email,
          fullName,
          subscription,
          effectiveTokenLimit: effectiveLimit,
          plan: plan
            ? {
                id: plan.id,
                nameDa: plan.nameDa,
                nameEn: plan.nameEn,
                priceDkk: plan.priceDkk,
                freeTrialDays: plan.freeTrialDays,
              }
            : null,
          isFunctional,
          isAdmin,
          isEmailUser,
          hasMfa,
          billing,
        });
      }
    }

    return NextResponse.json({
      email: freshUser.user.email,
      fullName,
      subscription,
      plan: plan
        ? {
            id: plan.id,
            nameDa: plan.nameDa,
            nameEn: plan.nameEn,
            priceDkk: plan.priceDkk,
            freeTrialDays: plan.freeTrialDays,
          }
        : null,
      isFunctional,
      isAdmin,
      isEmailUser,
      hasMfa,
      billing,
    });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[subscription] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
