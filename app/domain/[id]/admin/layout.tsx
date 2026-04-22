/**
 * Domain Admin layout — validates domain admin role before rendering.
 *
 * BIZZ-704: Server-side protection for /domain/[id]/admin/* routes.
 * Redirects non-admin users to /dashboard.
 *
 * @module app/domain/[id]/admin/layout
 */

import { redirect, notFound } from 'next/navigation';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { assertDomainAdmin } from '@/app/lib/domainAuth';

export default async function DomainAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  if (!isDomainFeatureEnabled()) notFound();

  const { id } = await params;

  try {
    await assertDomainAdmin(id);
  } catch {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
