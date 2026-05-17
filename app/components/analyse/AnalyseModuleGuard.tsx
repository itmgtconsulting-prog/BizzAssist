/**
 * AnalyseModuleGuard — feature flag + subscription guard for analyse-moduler.
 *
 * BIZZ-1240: Returnerer 404-lignende UI for disabled moduler i prod.
 * BIZZ-1241: Checker subscription modul-adgang via SubscriptionGate.
 *
 * Gate-rækkefølge: 1) feature flag (isModuleEnabled), 2) subscription (module:xxx).
 *
 * @param moduleId - Modul-ID fra analyseModules registry
 * @param children - Modul-indhold der vises hvis enabled + adgang
 * @returns Modul-indhold, feature-flag besked, eller subscription gate
 */

'use client';

import { isModuleEnabled } from '@/app/lib/analyseModules';
import SubscriptionGate from '@/app/components/SubscriptionGate';

interface Props {
  /** Modul-ID at checke */
  moduleId: string;
  /** Modul-indhold */
  children: React.ReactNode;
}

/**
 * Feature flag + subscription guard for analyse-moduler.
 *
 * @param props - moduleId + children
 * @returns Children hvis enabled + adgang, ellers blokerings-UI
 */
export default function AnalyseModuleGuard({ moduleId, children }: Props) {
  if (!isModuleEnabled(moduleId)) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <p className="text-slate-400 text-lg font-medium">Modul ikke tilgængeligt</p>
          <p className="text-slate-600 text-sm mt-2">
            Dette analyse-modul er ikke aktiveret i det nuværende miljø.
          </p>
        </div>
      </div>
    );
  }

  return <SubscriptionGate requiredFeature={`module:${moduleId}`}>{children}</SubscriptionGate>;
}
