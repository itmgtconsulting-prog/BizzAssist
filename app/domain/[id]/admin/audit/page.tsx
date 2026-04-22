/**
 * Audit log admin — /domain/[id]/admin/audit
 *
 * BIZZ-718: Admin-only filtered table of domain_audit_log entries +
 * CSV export. Gated by parent admin layout.
 */

import AuditLogClient from './AuditLogClient';

export default async function AuditLogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AuditLogClient domainId={id} />;
}
