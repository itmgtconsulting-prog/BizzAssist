/**
 * Generation detail page — /domain/[id]/generation/[genId]
 *
 * BIZZ-717: Status + preview + download. Member-gated by parent layout.
 */

import GenerationDetailClient from './GenerationDetailClient';

export default async function GenerationDetailPage({
  params,
}: {
  params: Promise<{ id: string; genId: string }>;
}) {
  const { id, genId } = await params;
  return <GenerationDetailClient domainId={id} genId={genId} />;
}
