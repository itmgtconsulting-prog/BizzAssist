/**
 * Vurderingsrapport sagsoversigt — /dashboard/analyse/vurderingsrapport
 *
 * BIZZ-1641: Liste af sager + opret ny sag.
 *
 * @module app/dashboard/analyse/vurderingsrapport
 */

import VurderingsrapportClient from './VurderingsrapportClient';

export const dynamic = 'force-dynamic';

export default function VurderingsrapportPage() {
  return <VurderingsrapportClient />;
}
