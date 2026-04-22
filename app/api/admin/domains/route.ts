/**
 * Admin domains API — list + create domains.
 *
 * BIZZ-701: Super-admin only. Creates domain + initial admin membership.
 *
 * GET  /api/admin/domains — list all domains with member/template/case counts
 * POST /api/admin/domains — create new domain
 *
 * @module api/admin/domains
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveTenantId } from '@/lib/api/auth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

/**
 * Validates that the current user is a super-admin.
 *
 * @returns user ID if admin, null otherwise
 */
async function requireSuperAdmin(): Promise<string | null> {
  const auth = await resolveTenantId();
  if (!auth) return null;

  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(auth.userId);
  if (!freshUser?.user?.app_metadata?.isAdmin) return null;

  return auth.userId;
}

/**
 * GET /api/admin/domains — list all domains with counts.
 */
export async function GET(): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const userId = await requireSuperAdmin();
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: domains, error } = (await (admin as any)
    .from('domain')
    .select('*')
    .order('created_at', { ascending: false })) as {
    data: Record<string, unknown>[] | null;
    error: unknown;
  };

  if (error) {
    logger.error('[admin/domains] List error:', error);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  // Enrich with counts
  const enriched = await Promise.all(
    (domains ?? []).map(async (d) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = admin as any;
      const [members, templates, cases] = await Promise.all([
        a.from('domain_member').select('id', { count: 'exact', head: true }).eq('domain_id', d.id),
        a
          .from('domain_template')
          .select('id', { count: 'exact', head: true })
          .eq('domain_id', d.id),
        a.from('domain_case').select('id', { count: 'exact', head: true }).eq('domain_id', d.id),
      ]);
      return {
        ...d,
        memberCount: members.count ?? 0,
        templateCount: templates.count ?? 0,
        caseCount: cases.count ?? 0,
      };
    })
  );

  return NextResponse.json(enriched);
}

/**
 * POST /api/admin/domains — create new domain.
 *
 * Body: { name, slug?, ownerTenantId, plan?, limits? }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const userId = await requireSuperAdmin();
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const slug =
    typeof body.slug === 'string' && body.slug.trim()
      ? body.slug
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
      : name
          .toLowerCase()
          .replace(/[^a-zæøå0-9]/g, '-')
          .replace(/-+/g, '-')
          .slice(0, 50);

  const ownerTenantId = typeof body.ownerTenantId === 'string' ? body.ownerTenantId : null;

  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: domain, error } = (await (admin as any)
    .from('domain')
    .insert({
      name,
      slug,
      owner_tenant_id: ownerTenantId ?? '00000000-0000-0000-0000-000000000000',
      plan: body.plan ?? 'enterprise_domain',
      limits: body.limits ?? undefined,
      created_by: userId,
    })
    .select()
    .single()) as { data: Record<string, unknown> | null; error: { message: string } | null };

  if (error) {
    logger.error('[admin/domains] Create error:', error.message);
    if (error.message.includes('ix_domain_slug_unique')) {
      return NextResponse.json({ error: 'Slug already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Audit log
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domain!.id,
    actor_user_id: userId,
    action: 'create_domain',
    target_type: 'domain',
    target_id: domain!.id,
    metadata: { name, slug },
  });

  return NextResponse.json(domain, { status: 201 });
}
