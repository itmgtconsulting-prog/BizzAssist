/**
 * Domain Template-Document attachment API — list, attach, update guidelines, detach.
 *
 * BIZZ-743: A template can reference one or more training/reference documents
 * with per-attachment "guidelines" text explaining why each doc is relevant.
 * The junction table `domain_template_document` was introduced in migration 067.
 *
 *   GET    /api/domain/[id]/templates/[templateId]/documents
 *     → list attachments (includes doc name + guidelines + sort_order)
 *   POST   /api/domain/[id]/templates/[templateId]/documents
 *     body: { documentId, guidelines?, sortOrder? }
 *     → attach a training doc to the template
 *   PATCH  /api/domain/[id]/templates/[templateId]/documents
 *     body: { attachmentId, guidelines?, sortOrder? }
 *     → update guidelines or reorder
 *   DELETE /api/domain/[id]/templates/[templateId]/documents?attachmentId=…
 *     → detach (doc itself remains in domain_training_doc)
 *
 * Members may GET; admins may POST/PATCH/DELETE.
 *
 * @module api/domain/[id]/templates/[templateId]/documents
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember, assertDomainAdmin } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string; templateId: string }> };

const attachSchema = z.object({
  documentId: z.string().uuid(),
  guidelines: z.string().max(4000).optional().nullable(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const patchSchema = z.object({
  attachmentId: z.string().uuid(),
  guidelines: z.string().max(4000).optional().nullable(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

/** Confirms the template belongs to this domain — prevents cross-domain access. */
async function assertTemplateInDomain(domainId: string, templateId: string): Promise<boolean> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('domain_template')
    .select('id')
    .eq('id', templateId)
    .eq('domain_id', domainId)
    .maybeSingle();
  return !!data;
}

/**
 * GET — list the documents attached to this template, including guidelines
 * text and the doc-side metadata needed to render a row (name, file_type).
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
  if (!(await assertTemplateInDomain(domainId, templateId))) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (admin as any)
    .from('domain_template_document')
    .select(
      'id, template_id, document_id, guidelines, sort_order, created_at, document:document_id (id, name, file_type, file_path)'
    )
    .eq('template_id', templateId)
    .eq('domain_id', domainId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })) as {
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  };
  if (error) {
    logger.warn('[template-docs] GET failed:', error.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  return NextResponse.json({ attachments: data ?? [] });
}

/**
 * POST — attach a training doc to the template. Returns the new junction row.
 * 409 if the doc is already attached (unique constraint).
 */
export async function POST(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, templateId } = await context.params;
  let userId: string;
  try {
    const ctx = await assertDomainAdmin(domainId);
    userId = ctx.userId;
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!(await assertTemplateInDomain(domainId, templateId))) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = attachSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  // Confirm the document belongs to the same domain (trigger enforces it too
  // but we want a friendlier error than the trigger message).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: doc } = await (admin as any)
    .from('domain_training_doc')
    .select('id, domain_id')
    .eq('id', parsed.data.documentId)
    .eq('domain_id', domainId)
    .maybeSingle();
  if (!doc) {
    return NextResponse.json({ error: 'Document not found in this domain' }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (admin as any)
    .from('domain_template_document')
    .insert({
      template_id: templateId,
      document_id: parsed.data.documentId,
      domain_id: domainId,
      guidelines: parsed.data.guidelines ?? null,
      sort_order: parsed.data.sortOrder ?? 0,
      created_by: userId,
    })
    .select()
    .single()) as { data: Record<string, unknown> | null; error: { message: string } | null };

  if (error) {
    if (error.message.includes('duplicate') || error.message.includes('unique')) {
      return NextResponse.json(
        { error: 'Document already attached to this template' },
        { status: 409 }
      );
    }
    logger.warn('[template-docs] POST failed:', error.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  // Audit log
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('domain_audit_log')
    .insert({
      domain_id: domainId,
      actor_user_id: userId,
      action: 'attach_document_to_template',
      target_type: 'template',
      target_id: templateId,
      metadata: { document_id: parsed.data.documentId },
    })
    .then(
      () => undefined,
      () => undefined
    );

  return NextResponse.json(data, { status: 201 });
}

/**
 * PATCH — update guidelines or sort-order on an existing attachment.
 */
export async function PATCH(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, templateId } = await context.params;
  try {
    await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!(await assertTemplateInDomain(domainId, templateId))) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = {};
  if ('guidelines' in parsed.data) patch.guidelines = parsed.data.guidelines ?? null;
  if ('sortOrder' in parsed.data) patch.sort_order = parsed.data.sortOrder;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (admin as any)
    .from('domain_template_document')
    .update(patch)
    .eq('id', parsed.data.attachmentId)
    .eq('template_id', templateId)
    .eq('domain_id', domainId)
    .select()
    .maybeSingle()) as { data: Record<string, unknown> | null; error: { message: string } | null };

  if (error) {
    logger.warn('[template-docs] PATCH failed:', error.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
  }
  return NextResponse.json(data);
}

/**
 * DELETE — detach a document from the template. Query param attachmentId
 * keeps the junction row id explicit (don't mix up with document_id).
 */
export async function DELETE(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, templateId } = await context.params;
  let userId: string;
  try {
    const ctx = await assertDomainAdmin(domainId);
    userId = ctx.userId;
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!(await assertTemplateInDomain(domainId, templateId))) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  }

  const attachmentId = req.nextUrl.searchParams.get('attachmentId');
  if (!attachmentId) {
    return NextResponse.json({ error: 'attachmentId query param required' }, { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) {
    return NextResponse.json({ error: 'Invalid attachmentId' }, { status: 400 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error, count } = (await (admin as any)
    .from('domain_template_document')
    .delete({ count: 'exact' })
    .eq('id', attachmentId)
    .eq('template_id', templateId)
    .eq('domain_id', domainId)) as {
    error: { message: string } | null;
    count: number | null;
  };
  if (error) {
    logger.warn('[template-docs] DELETE failed:', error.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  if (!count) {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('domain_audit_log')
    .insert({
      domain_id: domainId,
      actor_user_id: userId,
      action: 'detach_document_from_template',
      target_type: 'template',
      target_id: templateId,
      metadata: { attachment_id: attachmentId },
    })
    .then(
      () => undefined,
      () => undefined
    );

  return NextResponse.json({ ok: true });
}
