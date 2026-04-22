/**
 * Super-admin domain create page — /dashboard/admin/domains/new
 *
 * BIZZ-737 follow-up: the "Opret Domain" button on the domains list linked
 * to this route, but the page didn't exist (shipped 404 on test-env). This
 * route hosts a minimal form that POSTs to /api/admin/domains.
 *
 * Gated by isDomainFeatureEnabled() — returns notFound() in production.
 *
 * @module app/dashboard/admin/domains/new/page
 */
import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import DomainCreateClient from './DomainCreateClient';

export default async function AdminDomainsNewPage() {
  if (!isDomainFeatureEnabled()) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/dashboard');

  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (!freshUser?.user?.app_metadata?.isAdmin) redirect('/dashboard');

  return <DomainCreateClient />;
}
