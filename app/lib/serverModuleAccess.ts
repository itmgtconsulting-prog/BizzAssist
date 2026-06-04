/**
 * Server-side enforcement of analyse-module entitlement (BIZZ-1988).
 *
 * Generic for ALL modules and ALL plans: the source of truth is
 * `plan_configs.modules` (admin-editable via /dashboard/admin/plans) plus
 * per-tenant `subscription.addons`. This module is the *server-side* counterpart
 * to the client `SubscriptionGate`/`hasModuleAccess` — so access can no longer
 * be bypassed by disabling JavaScript or calling the API directly.
 *
 * Three layers:
 *   - `decideModuleAccess()` — pure decision (no IO, exhaustively unit-tested)
 *   - `assertModuleAccess()` — reads fresh `app_metadata` + `plan_configs`
 *   - `requireModuleAccess()` — API-route guard returning a 401/403 Response
 *
 * Mirrors `SubscriptionGate.hasAccess`: admin bypasses; otherwise the
 * subscription must be active (or within payment grace) AND the module must be
 * in the plan's modules or the subscription's addons.
 *
 * @module app/lib/serverModuleAccess
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { resolveTenantId } from '@/lib/api/auth';
import {
  isWithinPaymentGrace,
  type PlanDef,
  type UserSubscription,
  type SubStatus,
} from '@/app/lib/subscriptions';
import { logger } from '@/app/lib/logger';

/** Inputs to the pure module-access decision. */
export interface ModuleAccessInput {
  /** Whether the user is an internal admin (bypasses all gating). */
  isAdmin: boolean;
  /** Subscription status ('active', 'past_due', …). */
  status: string | undefined;
  /** Whether the subscription is within its payment-grace window. */
  withinGrace: boolean;
  /** Module IDs included in the user's plan (from plan_configs.modules). */
  planModules: string[];
  /** Module IDs purchased as per-tenant add-ons. */
  addons: string[];
  /** The module being accessed. */
  moduleId: string;
}

/**
 * Pure entitlement decision — identical logic for every module and plan.
 *
 * @param input - Admin flag, subscription state, plan modules, addons, target module
 * @returns true when access is granted
 */
export function decideModuleAccess(input: ModuleAccessInput): boolean {
  // Admin bypass — internal team always has access (parity with aiGate + SubscriptionGate).
  if (input.isAdmin) return true;
  // Subscription must be active or within payment grace.
  const activeOrGrace = input.status === 'active' || input.withinGrace;
  if (!activeOrGrace) return false;
  // Module must be in the plan or purchased as an add-on.
  return input.planModules.includes(input.moduleId) || input.addons.includes(input.moduleId);
}

/** Result of a server-side module-access check. */
export interface ModuleAccessResult {
  /** Whether access is granted. */
  allowed: boolean;
  /** Whether the user is an admin (informational — admins always allowed). */
  isAdmin: boolean;
}

/**
 * Resolve whether a user may access a given module, reading fresh
 * `app_metadata` (bypasses stale JWT) and the plan's modules from the DB.
 * Fail-closed: any lookup error denies access.
 *
 * @param moduleId - Analyse-module ID to check
 * @param userId   - Supabase auth user id
 * @returns Access result (allowed + isAdmin)
 */
export async function assertModuleAccess(
  moduleId: string,
  userId: string
): Promise<ModuleAccessResult> {
  if (!userId) return { allowed: false, isAdmin: false };

  const admin = createAdminClient();
  // Read fresh user metadata directly — never trust JWT claims that can be
  // stale after a plan change or admin toggle (same rationale as aiGate).
  const { data: userData, error: userErr } = await admin.auth.admin.getUserById(userId);
  if (userErr || !userData?.user) {
    logger.warn('[moduleAccess] getUserById failed');
    return { allowed: false, isAdmin: false };
  }

  const meta = (userData.user.app_metadata ?? {}) as Record<string, unknown>;
  const isAdmin = meta.isAdmin === true;
  if (isAdmin) return { allowed: true, isAdmin: true };

  const sub = (meta.subscription ?? {}) as {
    planId?: string;
    status?: string;
    addons?: string[];
    graceExpiresAt?: string;
  };

  // Resolve the plan's module list + grace window from the DB.
  let planModules: string[] = [];
  let paymentGraceHours = 0;
  if (sub.planId) {
    const { data: planRow } = (await admin
      .from('plan_configs')
      .select('modules,payment_grace_hours')
      .eq('plan_id', sub.planId)
      .single()) as { data: { modules?: string[]; payment_grace_hours?: number } | null };
    planModules = planRow?.modules ?? [];
    paymentGraceHours = planRow?.payment_grace_hours ?? 0;
  }

  // Minimal shapes for the shared grace helper.
  const planForGrace = { paymentGraceHours } as PlanDef;
  const subForGrace = {
    status: (sub.status as SubStatus) ?? 'pending',
    graceExpiresAt: sub.graceExpiresAt,
  } as UserSubscription;
  const withinGrace = isWithinPaymentGrace(subForGrace, planForGrace);

  const allowed = decideModuleAccess({
    isAdmin,
    status: sub.status,
    withinGrace,
    planModules,
    addons: sub.addons ?? [],
    moduleId,
  });
  return { allowed, isAdmin };
}

/**
 * API-route guard for module-gated endpoints. Call at the top of any module
 * API route (after rate-limiting). Returns a Response to return directly when
 * access is denied, or null when the caller may proceed.
 *
 * @param moduleId - Analyse-module ID the route belongs to
 * @returns 401/403 Response when blocked, null when allowed
 *
 * @example
 * const blocked = await requireModuleAccess('virksomhedshandler');
 * if (blocked) return blocked;
 */
export async function requireModuleAccess(moduleId: string): Promise<Response | null> {
  const auth = await resolveTenantId();
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { allowed } = await assertModuleAccess(moduleId, auth.userId);
  if (!allowed) {
    return Response.json(
      { error: 'Dette modul er ikke inkluderet i dit abonnement', code: 'module_not_in_plan' },
      { status: 403 }
    );
  }
  return null;
}
