/**
 * Super-admin domain documents (training-docs) page —
 *   /dashboard/admin/domains/[id]/training
 *
 * BIZZ-761: Inline-renders the existing training-docs client. See parent
 * page.tsx for rationale.
 *
 * @module app/dashboard/admin/domains/[id]/training/page
 */
import TrainingDocsClient from '@/app/domain/[id]/admin/training/TrainingDocsClient';

export default async function AdminDomainTrainingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TrainingDocsClient domainId={id} />;
}
