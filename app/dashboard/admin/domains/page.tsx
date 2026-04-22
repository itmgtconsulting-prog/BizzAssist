/**
 * Super-admin domains list page — /dashboard/admin/domains
 *
 * BIZZ-701: List all domains with member/template/case counts.
 * Gated by isDomainFeatureEnabled() — returns notFound() in production.
 *
 * @module app/dashboard/admin/domains/page
 */

import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import DomainsListClient from './DomainsListClient';

export default async function AdminDomainsPage() {
  if (!isDomainFeatureEnabled()) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/dashboard');

  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (!freshUser?.user?.app_metadata?.isAdmin) redirect('/dashboard');

  return <DomainsListClient />;
}
