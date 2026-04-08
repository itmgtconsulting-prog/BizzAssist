/**
 * Onboarding tenant-ID endpoint — GET /api/onboarding/tenant-id
 *
 * Returns the tenant ID for the currently authenticated user.
 * Used by the onboarding page to know which tenant record to update
 * with the company name the user enters during setup.
 *
 * Authentication: Supabase session cookie (server-side).
 * Returns 401 if the user is not authenticated or has no tenant.
 *
 * @module api/onboarding/tenant-id
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/onboarding/tenant-id
 *
 * @returns JSON `{ tenantId: string }` or 401 if unauthenticated
 */
export async function GET(): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
    }

    const { data } = (await supabase
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1)
      .single()) as { data: { tenant_id: string } | null; error: unknown };

    if (!data?.tenant_id) {
      return NextResponse.json({ error: 'Ingen tenant fundet' }, { status: 404 });
    }

    return NextResponse.json({ tenantId: data.tenant_id });
  } catch {
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
