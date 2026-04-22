/**
 * Super-admin domain audit-log page — /dashboard/admin/domains/[id]/audit
 *
 * BIZZ-761: Inline-renders the existing audit-log client. See parent
 * page.tsx for rationale.
 *
 * @module app/dashboard/admin/domains/[id]/audit/page
 */
import AuditLogClient from '@/app/domain/[id]/admin/audit/AuditLogClient';

export default async function AdminDomainAuditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AuditLogClient domainId={id} />;
}
