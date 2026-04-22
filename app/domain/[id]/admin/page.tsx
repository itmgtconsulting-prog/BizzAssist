/**
 * Domain Admin dashboard — /domain/[id]/admin
 *
 * BIZZ-704: Shows domain stats (users, templates, cases, recent activity).
 *
 * @module app/domain/[id]/admin/page
 */

import { notFound } from 'next/navigation';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import DomainAdminDashboardClient from './DomainAdminDashboardClient';

export default async function DomainAdminPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isDomainFeatureEnabled()) notFound();
  const { id } = await params;
  return <DomainAdminDashboardClient domainId={id} />;
}
