/**
 * Domain admin: Standard forsikringsbetingelser bibliotek.
 *
 * BIZZ-1921: CRUD-vedligeholdelse af delte standard betingelser.
 * Domain-admin kan oprette, redigere og slette betingelser der
 * deles med alle brugere i domain'et.
 *
 * @module app/domain/[id]/admin/betingelser/page
 */

import BetingelserAdminClient from './BetingelserAdminClient';

export default async function BetingelserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BetingelserAdminClient domainId={id} />;
}
