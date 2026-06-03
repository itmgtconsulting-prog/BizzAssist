/**
 * Server entry for kommune-energi analyse-modul.
 * BIZZ-1240: Wrapped i ServerModuleGate for feature flag check.
 */
import KommuneEnergiClient from './KommuneEnergiClient';
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <ServerModuleGate moduleId="kommune-energi">
      <KommuneEnergiClient />
    </ServerModuleGate>
  );
}
