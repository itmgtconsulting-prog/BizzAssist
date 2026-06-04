/**
 * Server entry for ejendomsinvestor analyse-modul.
 * BIZZ-1240: Wrapped i ServerModuleGate for feature flag check.
 */
import EjendomsinvestorClient from './EjendomsinvestorClient';
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <ServerModuleGate moduleId="ejendomsinvestor">
      <EjendomsinvestorClient />
    </ServerModuleGate>
  );
}
