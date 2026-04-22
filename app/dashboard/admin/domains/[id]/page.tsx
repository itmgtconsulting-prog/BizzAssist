/**
 * Super-admin domain detail — /dashboard/admin/domains/[id]
 *
 * BIZZ-761: Previously this route redirected to /domain/[id]/admin, which
 * dropped the super-admin out of the DashboardLayout (sidebar + topbar +
 * AdminNavTabs) into the tenant-scoped domain layout. Super-admins lost
 * all their admin navigation context.
 *
 * Now the domain-admin content renders directly under the admin-surface,
 * inheriting DashboardLayout + the admin role-guard. The layout.tsx in
 * this directory adds a sub-tab-bar (Oversigt | Brugere | Skabeloner |
 * Dokumenter | Historik | Indstillinger) so users can still navigate
 * within the domain without context-switching.
 *
 * Tenant members who aren't super-admin still use /domain/[id]/admin/*
 * which is unchanged — they don't have /dashboard/admin/* access.
 *
 * @module app/dashboard/admin/domains/[id]/page
 */
import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import DomainAdminDashboardClient from '@/app/domain/[id]/admin/DomainAdminDashboardClient';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AdminDomainDetailPage({ params }: PageProps) {
  if (!isDomainFeatureEnabled()) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/dashboard');

  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (!freshUser?.user?.app_metadata?.isAdmin) redirect('/dashboard');

  const { id } = await params;
  return <DomainAdminDashboardClient domainId={id} />;
}
