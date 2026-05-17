/**
 * Server entry for aml-kyc analyse-modul.
 * BIZZ-1240: Wrapped i AnalyseModuleGuard for feature flag check.
 */
import AmlKycClient from './AmlKycClient';
import AnalyseModuleGuard from '@/app/components/analyse/AnalyseModuleGuard';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <AnalyseModuleGuard moduleId="aml-kyc">
      <AmlKycClient />
    </AnalyseModuleGuard>
  );
}
