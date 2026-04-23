/**
 * Super-admin domain-detail layout — /dashboard/admin/domains/[id]/*
 *
 * BIZZ-761: Wraps the domain-admin content with a sub-tab-bar so super
 * admins can navigate between Oversigt / Brugere / Skabeloner / Dokumenter
 * / Historik / Indstillinger while staying inside the DashboardLayout
 * (sidebar + topbar + AdminNavTabs remain visible above).
 *
 * BIZZ-784: Layout now renders a 2-column master-detail split: the list
 * of domains sits in a fixed-width left sidebar and the selected domain's
 * detail fills the right column. The right column is collapsible so the
 * super-admin can let the list fill the viewport.
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
import { DomainDetailSplitView, type DomainSummary } from './DomainDetailSplitView';

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
  let domains: DomainSummary[] = [];

  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: current } = (await (admin as any)
      .from('domain')
      .select('name')
      .eq('id', id)
      .maybeSingle()) as { data: { name: string } | null };
    domainName = current?.name;

    // BIZZ-784: load all domains for the left-sidebar switcher.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: all } = (await (admin as any)
      .from('domain')
      .select('id, name, slug, status')
      .order('name', { ascending: true })) as { data: DomainSummary[] | null };
    domains = all ?? [];
  } catch {
    /* non-fatal — left sidebar will show empty state */
  }

  return (
    <div className="w-full px-4 py-6">
      <DomainDetailSplitView domainId={id} domainName={domainName} domains={domains}>
        {children}
      </DomainDetailSplitView>
    </div>
  );
}
