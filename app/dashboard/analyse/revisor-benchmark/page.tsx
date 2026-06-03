/**
 * Server entry for revisor-benchmark analyse-modul.
 * BIZZ-1240: Wrapped i ServerModuleGate for feature flag check.
 */
import RevisorBenchmarkClient from './RevisorBenchmarkClient';
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <ServerModuleGate moduleId="revisor-benchmark">
      <RevisorBenchmarkClient />
    </ServerModuleGate>
  );
}
