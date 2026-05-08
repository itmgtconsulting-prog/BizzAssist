/**
 * Server entry for forsikrings-gap-analyse.
 * BIZZ-1223/1240: Wrapped i AnalyseModuleGuard for feature flag check.
 */
import ForsikringGapClient from './ForsikringGapClient';
import AnalyseModuleGuard from '@/app/components/analyse/AnalyseModuleGuard';

export const dynamic = 'force-dynamic';

export default function ForsikringGapPage() {
  return (
    <AnalyseModuleGuard moduleId="forsikring">
      <ForsikringGapClient />
    </AnalyseModuleGuard>
  );
}
