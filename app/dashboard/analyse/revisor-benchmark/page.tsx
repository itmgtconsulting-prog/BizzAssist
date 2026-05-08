/**
 * Server entry for revisor-benchmark analyse-modul.
 * BIZZ-1231: Bruger shared AnalyseModulLayout framework.
 */
import RevisorBenchmarkClient from './RevisorBenchmarkClient';

export const dynamic = 'force-dynamic';

export default function RevisorBenchmarkPage() {
  return <RevisorBenchmarkClient />;
}
