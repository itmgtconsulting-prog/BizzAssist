/**
 * Server-side admin layout — validates admin role before rendering.
 *
 * Checks Supabase auth user's app_metadata.isAdmin flag. Redirects
 * non-admin users to /dashboard to prevent unauthorized access to
 * admin pages, even before client-side JS loads.
 *
 * BIZZ-293: Server-side protection for /dashboard/admin/* routes.
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.app_metadata?.isAdmin) {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
