/**
 * ServerModuleGate — server-side entitlement gate for analyse-module pages (BIZZ-1988).
 *
 * Async server component that enforces module access *before* any client code
 * renders. Unlike the client `AnalyseModuleGuard`/`SubscriptionGate`, this gate
 * runs on the server, so access cannot be bypassed by disabling JavaScript or
 * calling the underlying API directly (the matching API routes call
 * `requireModuleAccess`, returning 403 when unentitled).
 *
 * Checks, in order:
 *   1. Feature flag for the current environment (registry `enabled`)
 *   2. Authentication (must have a tenant session)
 *   3. Module entitlement (plan.modules ∪ addons, admin bypass)
 *
 * On failure it either `redirect()`s (disabled module → /dashboard,
 * unauthenticated → /login) or, when the user is authenticated but not entitled
 * to the module, renders an inline server-side upsell. The inline upsell is used
 * for the entitlement case on purpose: a `redirect()` from inside the page's
 * Suspense boundary (every module page has a `loading.tsx`) is delivered as a
 * *streamed* soft-redirect that the client subscription overlay can swallow,
 * leaving the user on a blank page. Rendering the upsell server-side is robust,
 * leaks no module content, and works even with JavaScript disabled.
 *
 * @module app/components/analyse/ServerModuleGate
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { resolveTenantId } from '@/lib/api/auth';
import { ANALYSE_MODULES, isModuleEnabled } from '@/app/lib/analyseModules';
import { assertModuleAccess } from '@/app/lib/serverModuleAccess';

interface Props {
  /** Analyse-module ID to gate (matches ANALYSE_MODULES[].id). */
  moduleId: string;
  /** Page content to render when access is granted. */
  children: React.ReactNode;
}

/**
 * Inline upsell shown server-side when an authenticated user is not entitled to
 * the requested module. Mirrors the `?locked` banner on the analyse overview.
 *
 * @param moduleId - The module that was denied (used to look up its label)
 * @returns Upsell panel directing the user to upgrade or buy the add-on
 */
function ModuleUpsell({ moduleId }: { moduleId: string }) {
  const label = ANALYSE_MODULES.find((m) => m.id === moduleId)?.label ?? 'Dette modul';
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div
        role="alert"
        className="text-center max-w-sm rounded-2xl border border-amber-500/30 bg-amber-500/10 p-8"
      >
        <div className="w-14 h-14 bg-amber-500/10 rounded-2xl flex items-center justify-center mx-auto mb-5">
          <Lock size={26} className="text-amber-400" />
        </div>
        <h2 className="text-lg font-bold text-white mb-2">
          {label} er ikke inkluderet i dit abonnement
        </h2>
        <p className="text-slate-300 text-sm mb-6 leading-relaxed">
          Opgradér din plan eller tilføj modulet som tilkøb for at få adgang.
        </p>
        <Link
          href="/dashboard/settings?tab=abonnement"
          className="inline-flex items-center gap-2 font-medium text-sm px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black transition-colors"
        >
          Se abonnement
        </Link>
      </div>
    </div>
  );
}

/**
 * Server-side module gate. Renders children only when the current user is
 * entitled to the module; otherwise redirects (auth/feature-flag) or renders an
 * inline upsell (entitlement).
 *
 * @param props - moduleId to gate and children to render when allowed
 * @returns The children when access is granted, otherwise an upsell (or redirects)
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
    return <ModuleUpsell moduleId={moduleId} />;
  }

  return <>{children}</>;
}
