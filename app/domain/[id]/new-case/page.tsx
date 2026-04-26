/**
 * New case — /domain/[id]/new-case
 *
 * BIZZ-712: Form to create a new case in this domain. Member-gated by the
 * parent layout.
 *
 * @module app/domain/[id]/new-case/page
 */

import NewCaseClient from './NewCaseClient';

export default async function NewCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NewCaseClient domainId={id} />;
}
