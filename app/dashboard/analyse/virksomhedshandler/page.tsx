/**
 * Server entry for virksomhedshandler analyse-modul.
 *
 * BIZZ-1929: M&A-radar med AI-værdiansættelse.
 * BIZZ-1988: Server-side modul-håndhævelse via ServerModuleGate (feature flag +
 * auth + plan/addon-entitlement) — erstatter det tidligere løse feature-flag.
 *
 * @module app/dashboard/analyse/virksomhedshandler/page
 */

import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';
import VirksomhedshandlerClient from './VirksomhedshandlerClient';

export const dynamic = 'force-dynamic';

/**
 * VirksomhedshandlerPage — M&A-radar side, gated server-side på modul-adgang.
 */
export default function VirksomhedshandlerPage() {
  return (
    <ServerModuleGate moduleId="virksomhedshandler">
      <VirksomhedshandlerClient />
    </ServerModuleGate>
  );
}
