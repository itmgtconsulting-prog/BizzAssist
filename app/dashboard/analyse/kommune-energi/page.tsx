/**
 * Server entry for kommune-energi analyse-modul.
 * BIZZ-1240: Wrapped i AnalyseModuleGuard for feature flag check.
 */
import KommuneEnergiClient from './KommuneEnergiClient';
import AnalyseModuleGuard from '@/app/components/analyse/AnalyseModuleGuard';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <AnalyseModuleGuard moduleId="kommune-energi">
      <KommuneEnergiClient />
    </AnalyseModuleGuard>
  );
}
