/**
 * Super-admin domain templates page — /dashboard/admin/domains/[id]/templates
 *
 * BIZZ-761: Inline-renders the existing domain-admin templates client so
 * DashboardLayout chrome is preserved. See parent page.tsx for rationale.
 *
 * @module app/dashboard/admin/domains/[id]/templates/page
 */
import TemplatesListClient from '@/app/domain/[id]/admin/templates/TemplatesListClient';

export default async function AdminDomainTemplatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TemplatesListClient domainId={id} />;
}
