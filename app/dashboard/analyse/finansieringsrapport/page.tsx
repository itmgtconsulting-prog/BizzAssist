/**
 * Server entry for finansieringsrapport analyse-modul.
 * BIZZ-1557: Wrapped i AnalyseModuleGuard for feature flag check.
 */
import FinansieringsrapportClient from './FinansieringsrapportClient';
import AnalyseModuleGuard from '@/app/components/analyse/AnalyseModuleGuard';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <AnalyseModuleGuard moduleId="finansieringsrapport">
      <FinansieringsrapportClient />
    </AnalyseModuleGuard>
  );
}
