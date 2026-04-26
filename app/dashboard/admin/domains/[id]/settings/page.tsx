/**
 * Super-admin domain settings page — /dashboard/admin/domains/[id]/settings
 *
 * BIZZ-761: Inline-renders the existing domain settings client. See parent
 * page.tsx for rationale.
 *
 * @module app/dashboard/admin/domains/[id]/settings/page
 */
import DomainSettingsClient from '@/app/domain/[id]/admin/settings/DomainSettingsClient';

export default async function AdminDomainSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DomainSettingsClient domainId={id} />;
}
