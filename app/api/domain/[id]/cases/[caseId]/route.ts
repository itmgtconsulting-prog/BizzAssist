/**
 * Domain Case Detail API — GET detail, PATCH metadata, DELETE case.
 *
 * BIZZ-713: Member-scoped for GET/PATCH. DELETE requires admin (the case
 * detail page only exposes DELETE to admins via the UI; the API enforces
 * it too in case of direct API calls).
 *
 * GET    /api/domain/:id/cases/:caseId  — case + active docs
 * PATCH  /api/domain/:id/cases/:caseId  — update name/client_ref/status/notes/tags
 * DELETE /api/domain/:id/cases/:caseId  — hard-delete (cascades to docs + generations)
 *
 * @module api/domain/[id]/cases/[caseId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember, assertDomainAdmin } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string; caseId: string }> };

/** Fields a member may patch on a case. */
// BIZZ-802: customer-link fields added to patchable set
const PATCHABLE_FIELDS = new Set([
  'name',
  'client_ref',
  'status',
  'notes',
  'tags',
  'client_kind',
  'client_cvr',
  'client_person_id',
  'client_name',
]);
const VALID_STATUSES = new Set(['open', 'closed', 'archived']);
const VALID_CLIENT_KINDS = new Set(['company', 'person']);

/**
 * GET — full case detail with active (non-deleted) docs ordered newest first.
 */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: domainId, caseId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: caseRow, error: caseErr } = await (admin as any)
    .from('domain_case')
    .select(
      'id, domain_id, name, client_ref, status, tags, notes, created_by, created_at, updated_at, client_kind, client_cvr, client_person_id, client_name'
    )
    .eq('id', caseId)
    .eq('domain_id', domainId)
    .maybeSingle();

  if (caseErr) {
    logger.error('[domain/cases/detail] GET error:', caseErr.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
  if (!caseRow) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: docs } = await (admin as any)
    .from('domain_case_doc')
    .select(
      'id, name, file_path, file_type, tags, size_bytes, uploaded_by, created_at, parse_status, parse_error'
    )
    .eq('case_id', caseId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  return NextResponse.json({ ...caseRow, docs: docs ?? [] });
}

/**
 * PATCH — partial update of case metadata.
 * Body keys: name, client_ref, status, notes, tags — all optional.
 */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: domainId, caseId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainMember(domainId);
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
    if (!PATCHABLE_FIELDS.has(k)) continue;
    if (k === 'status') {
      if (!VALID_STATUSES.has(String(v))) {
        return NextResponse.json({ error: 'status must be open|closed|archived' }, { status: 400 });
      }
      update.status = v;
    } else if (k === 'tags') {
      if (!Array.isArray(v)) continue;
      update.tags = v.filter((t): t is string => typeof t === 'string').slice(0, 20);
    } else if (k === 'name' || k === 'client_ref' || k === 'notes') {
      if (typeof v !== 'string') continue;
      if (k === 'name' && (!v.trim() || v.length > 200)) {
        return NextResponse.json({ error: 'name must be 1-200 chars' }, { status: 400 });
      }
      update[k] = k === 'name' ? v.trim() : v;
    } else if (k === 'client_kind') {
      // BIZZ-802: null explicitly allowed (clears the link)
      if (v === null) update.client_kind = null;
      else if (typeof v === 'string' && VALID_CLIENT_KINDS.has(v)) update.client_kind = v;
      else {
        return NextResponse.json(
          { error: 'client_kind must be company|person|null' },
          { status: 400 }
        );
      }
    } else if (k === 'client_cvr' || k === 'client_person_id' || k === 'client_name') {
      if (v === null) update[k] = null;
      else if (typeof v === 'string') update[k] = v.trim().slice(0, 200) || null;
      // ignore invalid types silently — partial updates shouldn't 400 on one bad field
    }
  }

  // BIZZ-802: If client_kind is explicitly being set, ensure the id column
  // matches. If it's being cleared, also clear the companion columns.
  if ('client_kind' in update) {
    if (update.client_kind === null) {
      update.client_cvr = null;
      update.client_person_id = null;
      update.client_name = null;
    } else if (update.client_kind === 'company' && !('client_cvr' in update)) {
      return NextResponse.json(
        { error: 'client_cvr is required when setting client_kind=company' },
        { status: 400 }
      );
    } else if (update.client_kind === 'person' && !('client_person_id' in update)) {
      return NextResponse.json(
        { error: 'client_person_id is required when setting client_kind=person' },
        { status: 400 }
      );
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }
  update.updated_at = new Date().toISOString();

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('domain_case')
    .update(update)
    .eq('id', caseId)
    .eq('domain_id', domainId);

  if (error) {
    logger.error('[domain/cases/detail] PATCH error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'update_case',
    target_type: 'case',
    target_id: caseId,
    metadata: { fields: Object.keys(update).filter((k) => k !== 'updated_at') },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE — hard-delete case (cascade removes docs + generations).
 * Admin-only to guard against accidental destruction by regular members.
 */
export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: domainId, caseId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();

  // Fetch file_paths so we can clean up storage in the same transaction
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: docs } = await (admin as any)
    .from('domain_case_doc')
    .select('file_path')
    .eq('case_id', caseId);
  const filePaths = ((docs ?? []) as Array<{ file_path: string }>).map((d) => d.file_path);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('domain_case')
    .delete()
    .eq('id', caseId)
    .eq('domain_id', domainId);

  if (error) {
    logger.error('[domain/cases/detail] DELETE error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // Best-effort storage cleanup — the DB cascade already removed the rows
  if (filePaths.length > 0) {
    try {
      await admin.storage.from('domain-files').remove(filePaths);
    } catch (err) {
      logger.warn('[domain/cases/detail] Storage cleanup failed (non-fatal):', err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'delete_case',
    target_type: 'case',
    target_id: caseId,
    metadata: { removed_docs: filePaths.length },
  });

  return NextResponse.json({ ok: true });
}
