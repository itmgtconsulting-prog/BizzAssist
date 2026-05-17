/**
 * Server entry for inkasso-aktivsoegning analyse-modul.
 * BIZZ-1240: Wrapped i AnalyseModuleGuard for feature flag check.
 */
import InkassoAktivsoegningClient from './InkassoAktivsoegningClient';
import AnalyseModuleGuard from '@/app/components/analyse/AnalyseModuleGuard';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <AnalyseModuleGuard moduleId="inkasso-aktivsoegning">
      <InkassoAktivsoegningClient />
    </AnalyseModuleGuard>
  );
}
