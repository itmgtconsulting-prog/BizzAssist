/**
 * AnalyseModuleGuard — server-side feature flag guard for analyse-moduler.
 *
 * BIZZ-1240: Returnerer 404-lignende UI for disabled moduler i prod.
 * Alle moduler er enabled i dev/preview. Checker via isModuleEnabled().
 *
 * @param moduleId - Modul-ID fra analyseModules registry
 * @param children - Modul-indhold der vises hvis enabled
 * @returns Modul-indhold eller "ikke tilgængeligt" besked
 */

'use client';

import { isModuleEnabled } from '@/app/lib/analyseModules';

interface Props {
  /** Modul-ID at checke */
  moduleId: string;
  /** Modul-indhold */
  children: React.ReactNode;
}

/**
 * Feature flag guard for analyse-moduler.
 *
 * @param props - moduleId + children
 * @returns Children hvis enabled, ellers 404-besked
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
  return <>{children}</>;
}
