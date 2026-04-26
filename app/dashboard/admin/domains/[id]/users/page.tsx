/**
 * Super-admin domain users page — /dashboard/admin/domains/[id]/users
 *
 * BIZZ-761: Renders the existing domain-admin users client inline so the
 * DashboardLayout + admin chrome is preserved. See parent page.tsx for
 * rationale.
 *
 * @module app/dashboard/admin/domains/[id]/users/page
 */
import DomainUsersClient from '@/app/domain/[id]/admin/users/DomainUsersClient';

export default async function AdminDomainUsersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DomainUsersClient domainId={id} />;
}
