/**
 * Server entry for kreditvurdering analyse-modul.
 * BIZZ-1240: Wrapped i ServerModuleGate for feature flag check.
 */
import KreditvurderingClient from './KreditvurderingClient';
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <ServerModuleGate moduleId="kreditvurdering">
      <KreditvurderingClient />
    </ServerModuleGate>
  );
}
