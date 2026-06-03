/**
 * ServerModuleGate — server-side entitlement gate for analyse-module pages (BIZZ-1988).
 *
 * Async server component that enforces module access *before* any client code
 * renders. Unlike the client `AnalyseModuleGuard`/`SubscriptionGate`, this gate
 * runs on the server, so access cannot be bypassed by disabling JavaScript.
 *
 * Checks, in order:
 *   1. Feature flag for the current environment (registry `enabled`)
 *   2. Authentication (must have a tenant session)
 *   3. Module entitlement (plan.modules ∪ addons, admin bypass)
 *
 * On any failure it `redirect()`s — to /dashboard when the module is disabled
 * in this environment, /login when unauthenticated, or
 * /dashboard/analyse?locked=<id> when the plan does not include the module.
 *
 * @module app/components/analyse/ServerModuleGate
 */

import { redirect } from 'next/navigation';
import { resolveTenantId } from '@/lib/api/auth';
import { isModuleEnabled } from '@/app/lib/analyseModules';
import { assertModuleAccess } from '@/app/lib/serverModuleAccess';

interface Props {
  /** Analyse-module ID to gate (matches ANALYSE_MODULES[].id). */
  moduleId: string;
  /** Page content to render when access is granted. */
  children: React.ReactNode;
}

/**
 * Server-side module gate. Renders children only when the current user is
 * entitled to the module; otherwise redirects.
 *
 * @param props - moduleId to gate and children to render when allowed
 * @returns The children when access is granted (otherwise redirects)
 */
export default async function ServerModuleGate({ moduleId, children }: Props) {
  // 1. Feature flag — module must be enabled in this environment.
  if (!isModuleEnabled(moduleId)) {
    redirect('/dashboard');
  }

  // 2. Authentication — must have a tenant-scoped session.
  const auth = await resolveTenantId();
  if (!auth) {
    redirect('/login');
  }

  // 3. Entitlement — plan.modules ∪ addons (admin bypasses).
  const { allowed } = await assertModuleAccess(moduleId, auth.userId);
  if (!allowed) {
    redirect(`/dashboard/analyse?locked=${encodeURIComponent(moduleId)}`);
  }

  return <>{children}</>;
}
