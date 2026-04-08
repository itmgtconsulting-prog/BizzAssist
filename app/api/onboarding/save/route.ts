/**
 * Onboarding save endpoint — POST /api/onboarding/save
 *
 * Persists onboarding data collected during the wizard:
 *   - Updates `public.tenants.name` (and optionally `cvr_number`) for the
 *     user's tenant record.
 *   - The industry and headcount fields are stored in user_metadata via the
 *     client-side `supabase.auth.updateUser` call — this route only handles
 *     tenant-level data that requires the admin client to bypass RLS.
 *
 * Request body (JSON):
 *   tenantId    string           — UUID of the tenant to update
 *   companyName string           — Human-readable company name
 *   companyCvr  string | null    — Optional CVR number
 *   industry    string | null    — Optional industry slug
 *   headcount   string | null    — Optional headcount bracket
 *   plan        string           — Chosen plan (free | pro | enterprise)
 *
 * Authentication: Supabase session cookie.
 * Authorization: verifies caller is a member of the supplied tenantId before
 *   any update is performed — prevents cross-tenant writes.
 *
 * GDPR: no PII beyond company name/CVR is stored in tenant table.
 *   Retention: tenant record is deleted when the tenant account is closed
 *   (cascade via tenant_memberships → tenants RLS / admin delete flow).
 *
 * @module api/onboarding/save
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/** Expected shape of the POST body */
interface OnboardingSaveBody {
  tenantId: string;
  companyName: string;
  companyCvr: string | null;
  industry: string | null;
  headcount: string | null;
  plan: string;
}

/**
 * POST /api/onboarding/save
 *
 * Saves onboarding data for the user's tenant.
 *
 * @param request - Incoming POST with JSON body matching OnboardingSaveBody
 * @returns 200 on success, 400/401/403/500 on error
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // ── Authenticate ──────────────────────────────────────────────────────────
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    let body: OnboardingSaveBody;
    try {
      body = (await request.json()) as OnboardingSaveBody;
    } catch {
      return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
    }

    const { tenantId, companyName, companyCvr } = body;

    if (!tenantId || typeof tenantId !== 'string') {
      return NextResponse.json({ error: 'tenantId mangler' }, { status: 400 });
    }
    if (!companyName || typeof companyName !== 'string' || companyName.trim().length === 0) {
      // Company name is optional — allow empty string (skip update)
      // Return early if tenantId is the only thing missing
    }

    // ── Authorise: verify caller is a member of the given tenant ─────────────
    const { data: membership } = (await supabase
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .eq('tenant_id', tenantId)
      .limit(1)
      .single()) as { data: { tenant_id: string } | null; error: unknown };

    if (!membership) {
      return NextResponse.json({ error: 'Ingen adgang til denne tenant' }, { status: 403 });
    }

    // ── Update tenant record ──────────────────────────────────────────────────
    // Uses the admin client to bypass RLS (tenant record lives in public schema
    // which requires service-role for updates from API routes).
    if (companyName.trim().length > 0) {
      const admin = createAdminClient();
      const updatePayload: Record<string, string> = {
        name: companyName.trim(),
        updated_at: new Date().toISOString(),
      };
      if (companyCvr && typeof companyCvr === 'string' && companyCvr.trim()) {
        updatePayload['cvr_number'] = companyCvr.trim();
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updateErr } = await (admin.from('tenants') as any)
        .update(updatePayload)
        .eq('id', tenantId);

      if (updateErr) {
        console.error(
          '[onboarding/save] tenant update error:',
          (updateErr as { message?: string }).message
        );
        // Non-fatal — return success so onboarding completes
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[onboarding/save] Unexpected error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
