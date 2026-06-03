/**
 * Server entry for annonce analyse-modul.
 * BIZZ-1240: Wrapped i ServerModuleGate for feature flag check.
 */
import AnnonceClient from './AnnonceClient';
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <ServerModuleGate moduleId="annonce">
      <AnnonceClient />
    </ServerModuleGate>
  );
}
