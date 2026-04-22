/**
 * Domain user dashboard — /domain/[id]
 *
 * BIZZ-712: Landing page for domain members. Shows a searchable + filterable
 * list of cases with a "New case" CTA. Member-gated by the parent layout.
 *
 * @module app/domain/[id]/page
 */

import DomainUserDashboardClient from './DomainUserDashboardClient';

export default async function DomainUserDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DomainUserDashboardClient domainId={id} />;
}
