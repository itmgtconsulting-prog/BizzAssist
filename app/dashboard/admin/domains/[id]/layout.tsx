/**
 * Super-admin domain-detail layout — /dashboard/admin/domains/[id]/*
 *
 * BIZZ-761: Wraps the domain-admin content with a sub-tab-bar so super
 * admins can navigate between Oversigt / Brugere / Skabeloner / Dokumenter
 * / Historik / Indstillinger while staying inside the DashboardLayout
 * (sidebar + topbar + AdminNavTabs remain visible above).
 *
 * Unlike the tenant-scope /domain/[id]/admin/* layout, this one does not
 * run assertDomainAdmin — super-admins are not automatically a member of
 * every domain, and the parent /dashboard/admin/layout.tsx already gates
 * on app_metadata.isAdmin. We only need the feature-flag + domain-exists
 * checks here.
 *
 * @module app/dashboard/admin/domains/[id]/layout
 */
import { notFound } from 'next/navigation';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { createAdminClient } from '@/lib/supabase/admin';
import { DomainAdminTabs } from '@/app/domain/[id]/admin/DomainAdminTabs';

export default async function AdminDomainDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  if (!isDomainFeatureEnabled()) notFound();

  const { id } = await params;

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
      <DomainAdminTabs
        domainId={id}
        domainName={domainName}
        hrefBase={`/dashboard/admin/domains/${id}`}
        backHref="/dashboard/admin/domains"
      />
      {children}
    </>
  );
}
