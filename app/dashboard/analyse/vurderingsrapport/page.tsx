/**
 * Vurderingsrapport sagsoversigt — /dashboard/analyse/vurderingsrapport
 *
 * BIZZ-1641: Liste af sager + opret ny sag.
 * BIZZ-1988: Server-side modul-håndhævelse via ServerModuleGate.
 *
 * @module app/dashboard/analyse/vurderingsrapport
 */

import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';
import VurderingsrapportClient from './VurderingsrapportClient';

export const dynamic = 'force-dynamic';

export default function VurderingsrapportPage() {
  return (
    <ServerModuleGate moduleId="vurderingsrapport">
      <VurderingsrapportClient />
    </ServerModuleGate>
  );
}
