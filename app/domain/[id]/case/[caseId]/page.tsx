/**
 * Case detail page — /domain/[id]/case/[caseId]
 *
 * BIZZ-713: Member-gated (parent layout). Renders the case metadata with
 * inline-edit + a drag-drop upload zone + doc list.
 *
 * @module app/domain/[id]/case/[caseId]/page
 */

import CaseDetailClient from './CaseDetailClient';

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string; caseId: string }>;
}) {
  const { id, caseId } = await params;
  return <CaseDetailClient domainId={id} caseId={caseId} />;
}
