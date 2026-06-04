/**
 * Server entry for finansieringsrapport analyse-modul.
 * BIZZ-1557: Wrapped i ServerModuleGate for feature flag check.
 */
import FinansieringsrapportClient from './FinansieringsrapportClient';
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <ServerModuleGate moduleId="finansieringsrapport">
      <FinansieringsrapportClient />
    </ServerModuleGate>
  );
}
