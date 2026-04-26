/**
 * Single training-doc API — GET detail, PATCH metadata, DELETE.
 *
 * BIZZ-709: Admin-only for PATCH + DELETE. GET is member-scoped (generation
 * pipeline may need full doc info including extracted_text).
 *
 * @module api/domain/[id]/training-docs/[docId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember, assertDomainAdmin } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string; docId: string }> };

const PATCHABLE = new Set(['name', 'description', 'doc_type', 'tags']);
const VALID_DOC_TYPES = new Set(['guide', 'policy', 'reference', 'example']);

async function fetchDoc(domainId: string, docId: string) {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('domain_training_doc')
    .select(
      'id, domain_id, name, description, doc_type, tags, file_path, parse_status, parse_error, created_at'
    )
    .eq('id', docId)
    .eq('domain_id', domainId)
    .maybeSingle();
  return data as { id: string; domain_id: string; file_path: string } | null;
}

export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, docId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const doc = await fetchDoc(domainId, docId);
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(doc);
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, docId } = await context.params;
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
    if (k === 'doc_type') {
      if (!VALID_DOC_TYPES.has(String(v))) {
        return NextResponse.json(
          { error: 'doc_type must be guide|policy|reference|example' },
          { status: 400 }
        );
      }
      update.doc_type = v;
    } else if (k === 'tags') {
      if (!Array.isArray(v)) continue;
      update.tags = v.filter((t): t is string => typeof t === 'string').slice(0, 20);
    } else if (typeof v === 'string') {
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
    .from('domain_training_doc')
    .update(update)
    .eq('id', docId)
    .eq('domain_id', domainId);

  if (error) {
    logger.error('[domain/training-docs/detail] PATCH error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'update_training_doc',
    target_type: 'training_doc',
    target_id: docId,
    metadata: { fields: Object.keys(update).filter((k) => k !== 'updated_at') },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, docId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const doc = await fetchDoc(domainId, docId);
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('domain_training_doc')
    .delete()
    .eq('id', docId)
    .eq('domain_id', domainId);

  if (error) {
    logger.error('[domain/training-docs/detail] DELETE error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // Best-effort storage cleanup
  try {
    await admin.storage.from('domain-files').remove([doc.file_path]);
  } catch (err) {
    logger.warn('[domain/training-docs/detail] Storage cleanup failed:', err);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'delete_training_doc',
    target_type: 'training_doc',
    target_id: docId,
  });

  return NextResponse.json({ ok: true });
}
