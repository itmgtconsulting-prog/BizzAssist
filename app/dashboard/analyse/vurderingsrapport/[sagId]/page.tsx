/**
 * Vurderingsrapport sag-detalje — /dashboard/analyse/vurderingsrapport/[sagId]
 *
 * BIZZ-1641: Sag med upload-zoner og rapport-tabs.
 *
 * @module app/dashboard/analyse/vurderingsrapport/[sagId]
 */

import SagDetaljeClient from './SagDetaljeClient';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ sagId: string }>;
}

export default async function SagDetaljePage({ params }: Props) {
  const { sagId } = await params;
  return <SagDetaljeClient sagId={sagId} />;
}
