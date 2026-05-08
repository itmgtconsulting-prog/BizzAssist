/**
 * Server entry for ejendomsinvestor analyse-modul.
 * BIZZ-1240: Wrapped i AnalyseModuleGuard for feature flag check.
 */
import EjendomsinvestorClient from './EjendomsinvestorClient';
import AnalyseModuleGuard from '@/app/components/analyse/AnalyseModuleGuard';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <AnalyseModuleGuard moduleId="ejendomsinvestor">
      <EjendomsinvestorClient />
    </AnalyseModuleGuard>
  );
}
