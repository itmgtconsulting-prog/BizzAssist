/**
 * Server entry for due-diligence analyse-modul.
 * BIZZ-1240: Wrapped i ServerModuleGate for feature flag check.
 */
import DueDiligenceClient from './DueDiligenceClient';
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <ServerModuleGate moduleId="due-diligence">
      <DueDiligenceClient />
    </ServerModuleGate>
  );
}
