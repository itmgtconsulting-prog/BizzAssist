/**
 * Server entry for boligpris analyse-modul.
 *
 * BIZZ-2029: Boligpris Dashboard med interaktivt kommunekort og prisudvikling.
 * Gated server-side via ServerModuleGate (feature flag + auth + plan/addon).
 *
 * @module app/dashboard/analyse/boligpris/page
 */

import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';
import BoligprisClient from './BoligprisClient';

export const dynamic = 'force-dynamic';

/**
 * BoligprisPage — interaktivt boligpris dashboard, gated server-side.
 */
export default function BoligprisPage() {
  return (
    <ServerModuleGate moduleId="boligpris">
      <BoligprisClient />
    </ServerModuleGate>
  );
}
