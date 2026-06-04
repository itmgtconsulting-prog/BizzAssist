/**
 * Server entry for dækningsanalyse-modul.
 *
 * BIZZ-1991: Upload kundeadresser → heatmap + dækningstabel pr. matrikel.
 * Server-side modul-håndhævelse via ServerModuleGate.
 *
 * @module app/dashboard/analyse/daekningsanalyse/page
 */

import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';
import DaekningsanalyseClient from './DaekningsanalyseClient';

export const dynamic = 'force-dynamic';

/**
 * DaekningsanalysePage — gated server-side på modul-adgang.
 */
export default function DaekningsanalysePage() {
  return (
    <ServerModuleGate moduleId="daekningsanalyse">
      <DaekningsanalyseClient />
    </ServerModuleGate>
  );
}
