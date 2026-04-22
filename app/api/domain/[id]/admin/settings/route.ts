/**
 * Domain Admin Settings API — PATCH /api/domain/:id/admin/settings
 *
 * BIZZ-706: Domain Admins can edit their own domain's settings (name, AI prefs,
 * retention, notifications, email-domain-guard). Super-admin-assigned caps
 * (plan, limits) cannot be modified here — only via /api/admin/domains/:id.
 *
 * Security:
 *   - Requires authenticated user with domain admin role (assertDomainAdmin)
 *   - Writes to public.domain — audit logged in domain_audit_log
 *   - Feature-flag gated via isDomainFeatureEnabled()
 *
 * @module api/domain/[id]/admin/settings
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainAdmin } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string }> };

/** Whitelist of fields a Domain Admin may modify. */
const DOMAIN_ADMIN_EDITABLE_FIELDS = new Set([
  'name',
  'settings',
  'email_domain_whitelist',
  'email_domain_enforcement',
]);

/**
 * GET /api/domain/:id/admin/settings — returns current settings for the domain.
 * Domain admin only.
 */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id } = await context.params;

  try {
    await assertDomainAdmin(id);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('domain')
    .select(
      'id, name, slug, status, plan, limits, settings, email_domain_whitelist, email_domain_enforcement'
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
    logger.error('[domain/admin/settings] GET error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(data);
}

/**
 * PATCH /api/domain/:id/admin/settings — update domain settings.
 *
 * Body: { name?, settings?, email_domain_whitelist?, email_domain_enforcement? }
 * Only whitelisted fields are applied; unknown/restricted fields are ignored.
 * Domain admin only.
 */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id } = await context.params;

  let ctx;
  try {
    ctx = await assertDomainAdmin(id);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (DOMAIN_ADMIN_EDITABLE_FIELDS.has(k)) {
      update[k] = v;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  // Validate enforcement value if provided
  if (
    update.email_domain_enforcement !== undefined &&
    !['off', 'warn', 'hard'].includes(update.email_domain_enforcement as string)
  ) {
    return NextResponse.json(
      { error: 'email_domain_enforcement must be off|warn|hard' },
      { status: 400 }
    );
  }

  update.updated_at = new Date().toISOString();

  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (admin as any).from('domain').update(update).eq('id', id);

  if (updateError) {
    logger.error('[domain/admin/settings] PATCH error:', updateError.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // Audit log
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: id,
    actor_user_id: ctx.userId,
    action: 'update_settings',
    target_type: 'domain',
    target_id: id,
    metadata: { fields: Object.keys(update).filter((k) => k !== 'updated_at') },
  });

  return NextResponse.json({ ok: true });
}
