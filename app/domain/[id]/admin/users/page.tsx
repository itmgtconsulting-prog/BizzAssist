/**
 * Domain Admin Users page — /domain/[id]/admin/users
 *
 * BIZZ-705: Server component shell. Role + feature-flag gate in parent layout.
 *
 * @module app/domain/[id]/admin/users/page
 */

import DomainUsersClient from './DomainUsersClient';

export default async function DomainUsersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DomainUsersClient domainId={id} />;
}
