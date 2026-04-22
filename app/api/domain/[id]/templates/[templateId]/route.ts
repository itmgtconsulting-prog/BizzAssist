/**
 * Domain Single-Template API — GET detail, PATCH metadata, DELETE template.
 *
 * BIZZ-707: Admin-only for PATCH + DELETE. GET is member-scoped so the
 * generation UI can show detailed placeholder lists when picking a template.
 *
 * @module api/domain/[id]/templates/[templateId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember, assertDomainAdmin } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string; templateId: string }> };

const PATCHABLE = new Set(['name', 'description', 'instructions', 'examples', 'status']);

async function fetchTemplate(domainId: string, templateId: string) {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('domain_template')
    .select(
      'id, domain_id, name, description, instructions, examples, file_path, file_type, placeholders, status, version, created_at, updated_at'
    )
    .eq('id', templateId)
    .eq('domain_id', domainId)
    .maybeSingle();
  return data as {
    id: string;
    domain_id: string;
    file_path: string;
  } | null;
}

/**
 * GET — full template detail incl. instructions, examples, placeholders.
 */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, templateId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const tpl = await fetchTemplate(domainId, templateId);
  if (!tpl) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(tpl);
}

/**
 * PATCH — update metadata (name, description, instructions, examples, status).
 * Admin-only. Changes to instructions/examples are the main thing template
 * authors do in the editor (BIZZ-721) to improve AI-fill accuracy.
 */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, templateId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
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
    if (!PATCHABLE.has(k)) continue;
    if (k === 'status') {
      if (v !== 'active' && v !== 'archived') {
        return NextResponse.json({ error: 'status must be active|archived' }, { status: 400 });
      }
      update.status = v;
    } else if (k === 'examples') {
      if (!Array.isArray(v)) continue;
      update.examples = v;
    } else {
      if (typeof v !== 'string') continue;
      if (k === 'name' && (!v.trim() || v.length > 200)) {
        return NextResponse.json({ error: 'name must be 1-200 chars' }, { status: 400 });
      }
      update[k] = k === 'name' ? v.trim() : v;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }
  update.updated_at = new Date().toISOString();

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('domain_template')
    .update(update)
    .eq('id', templateId)
    .eq('domain_id', domainId);

  if (error) {
    logger.error('[domain/templates/detail] PATCH error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'update_template',
    target_type: 'template',
    target_id: templateId,
    metadata: { fields: Object.keys(update).filter((k) => k !== 'updated_at') },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE — hard-delete template + version rows + storage files.
 * Admin-only. Does NOT delete generations that used this template (they keep
 * a soft reference via output_path for auditability).
 */
export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, templateId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const tpl = await fetchTemplate(domainId, templateId);
  if (!tpl) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const admin = createAdminClient();
  // Collect version-file paths for storage cleanup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: versions } = await (admin as any)
    .from('domain_template_version')
    .select('file_path')
    .eq('template_id', templateId);
  const filePaths = [
    tpl.file_path,
    ...((versions ?? []) as Array<{ file_path: string }>).map((v) => v.file_path),
  ].filter(Boolean);

  // Cascade removes versions; template itself removed here
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('domain_template')
    .delete()
    .eq('id', templateId)
    .eq('domain_id', domainId);

  if (error) {
    logger.error('[domain/templates/detail] DELETE error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // Best-effort storage cleanup
  if (filePaths.length > 0) {
    try {
      await admin.storage.from('domain-files').remove(filePaths);
    } catch (err) {
      logger.warn('[domain/templates/detail] Storage cleanup failed (non-fatal):', err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'delete_template',
    target_type: 'template',
    target_id: templateId,
    metadata: { removed_files: filePaths.length },
  });

  return NextResponse.json({ ok: true });
}
