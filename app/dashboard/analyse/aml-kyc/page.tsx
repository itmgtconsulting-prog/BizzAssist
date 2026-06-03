/**
 * Server entry for aml-kyc analyse-modul.
 * BIZZ-1240: Wrapped i ServerModuleGate for feature flag check.
 */
import AmlKycClient from './AmlKycClient';
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <ServerModuleGate moduleId="aml-kyc">
      <AmlKycClient />
    </ServerModuleGate>
  );
}
