/**
 * Training docs admin — /domain/[id]/admin/training
 *
 * BIZZ-709: Admin landing for uploading + managing training documents.
 * Route gated by parent admin layout (assertDomainAdmin).
 */

import TrainingDocsClient from './TrainingDocsClient';

export default async function TrainingDocsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TrainingDocsClient domainId={id} />;
}
