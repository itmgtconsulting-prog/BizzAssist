/**
 * Domain Admin layout — validates domain admin role + renders shared tabs.
 *
 * BIZZ-704: Server-side protection for /domain/[id]/admin/* routes.
 * BIZZ-742: Shared tab-bar across all admin subpages (Oversigt, Brugere,
 * Skabeloner, Dokumenter, Historik, Indstillinger) with back-arrow.
 * Redirects non-admin users to /dashboard.
 *
 * @module app/domain/[id]/admin/layout
 */

import { redirect, notFound } from 'next/navigation';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { assertDomainAdmin } from '@/app/lib/domainAuth';
import { createAdminClient } from '@/lib/supabase/admin';
import { DomainAdminTabs } from './DomainAdminTabs';

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

  // Load the domain name for the tab-bar header. Fail-soft — if this
  // query fails we just skip the name, tab-bar still renders.
  let domainName: string | undefined;
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = (await (admin as any)
      .from('domain')
      .select('name')
      .eq('id', id)
      .maybeSingle()) as { data: { name: string } | null };
    domainName = data?.name;
  } catch {
    /* non-fatal */
  }

  return (
    <>
      <DomainAdminTabs domainId={id} domainName={domainName} />
      {children}
    </>
  );
}
