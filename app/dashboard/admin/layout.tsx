/**
 * Server-side admin layout — validates admin role before rendering.
 *
 * Uses admin client to fetch fresh app_metadata (session JWT may have
 * stale metadata). Redirects non-admin users to /dashboard.
 *
 * BIZZ-293: Server-side protection for /dashboard/admin/* routes.
 * BIZZ-344: Fixed to use admin client for fresh app_metadata check.
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/dashboard');
  }

  // Fetch fresh user data via admin client — session JWT may have stale app_metadata
  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);

  if (!freshUser?.user?.app_metadata?.isAdmin) {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
