/**
 * Module access helpers for analyse-modul gating.
 *
 * BIZZ-1241: Determines whether a user has access to a specific analyse-module
 * based on plan.modules + subscription.addons. Admin users bypass all checks.
 *
 * @module app/lib/moduleAccess
 */

import { resolvePlan, type UserSubscription } from '@/app/lib/subscriptions';

/**
 * Check if a subscription grants access to a specific analyse-module.
 * Access is granted when the module ID is in either the plan's modules list
 * or the subscription's addons list.
 *
 * @param sub - User's subscription (null = no access)
 * @param moduleId - Analyse-module ID to check
 * @returns true if the module is included in plan or purchased as add-on
 */
export function hasModuleAccess(sub: UserSubscription | null, moduleId: string): boolean {
  if (!sub) return false;
  const plan = resolvePlan(sub.planId);
  if (plan.modules.includes(moduleId)) return true;
  if (sub.addons?.includes(moduleId)) return true;
  return false;
}
