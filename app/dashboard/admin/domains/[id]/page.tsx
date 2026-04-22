/**
 * Super-admin domain detail — /dashboard/admin/domains/[id]
 *
 * The tenant-scoped domain admin UI at /domain/[id]/admin is the canonical
 * detail view (BIZZ-704). Rather than duplicate it, this super-admin route
 * redirects into the same UI. Access is gated server-side by the admin
 * check below AND by assertDomainAdmin() inside the target route — a
 * super-admin has app_metadata.isAdmin=true which satisfies both.
 *
 * Gated by isDomainFeatureEnabled() — returns notFound() in production.
 *
 * @module app/dashboard/admin/domains/[id]/page
 */
import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';

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
  redirect(`/domain/${id}/admin`);
}
