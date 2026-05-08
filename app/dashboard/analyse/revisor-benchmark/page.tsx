/**
 * Server entry for revisor-benchmark analyse-modul.
 * BIZZ-1240: Wrapped i AnalyseModuleGuard for feature flag check.
 */
import RevisorBenchmarkClient from './RevisorBenchmarkClient';
import AnalyseModuleGuard from '@/app/components/analyse/AnalyseModuleGuard';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <AnalyseModuleGuard moduleId="revisor-benchmark">
      <RevisorBenchmarkClient />
    </AnalyseModuleGuard>
  );
}
