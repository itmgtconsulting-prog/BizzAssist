/**
 * Server entry for inkasso-aktivsoegning analyse-modul.
 * BIZZ-1240: Wrapped i ServerModuleGate for feature flag check.
 */
import InkassoAktivsoegningClient from './InkassoAktivsoegningClient';
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <ServerModuleGate moduleId="inkasso-aktivsoegning">
      <InkassoAktivsoegningClient />
    </ServerModuleGate>
  );
}
