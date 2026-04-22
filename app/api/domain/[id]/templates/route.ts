/**
 * Domain Templates API — list + upload templates.
 *
 * BIZZ-707: Admin-only for writes (templates are shared infrastructure).
 * GET is member-scoped so members can see which templates are available
 * for generation.
 *
 * POST upload pipeline:
 *   1. Validate file type (.docx/.pdf/.txt) and size (20 MB cap)
 *   2. Write to storage under {domain_id}/templates/…
 *   3. Extract plain text via domainTextExtraction
 *   4. Detect placeholders via domainPlaceholderDetect
 *   5. Create domain_template row + initial domain_template_version
 *   6. Audit log
 *
 * Response includes the detected placeholder list so the uploader UI
 * (BIZZ-721 template editor) can preview immediately.
 *
 * @module api/domain/[id]/templates
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember, assertDomainAdmin } from '@/app/lib/domainAuth';
import { uploadDomainFile } from '@/app/lib/domainStorage';
import { extractTextFromBuffer, type DomainFileType } from '@/app/lib/domainTextExtraction';
import { detectPlaceholders } from '@/app/lib/domainPlaceholderDetect';
import { embedDomainSource } from '@/app/lib/domainEmbeddingWorker';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/** Max file size for templates (20 MB — templates are smaller than case docs). */
const MAX_TEMPLATE_MB = 20;

const TEMPLATE_MIME_TO_TYPE: Record<string, 'docx' | 'pdf' | 'txt'> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/**
 * GET — list templates in the domain. Member-scoped so generation UI can
 * populate a template picker for any member.
 */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('domain_template')
    .select(
      'id, name, description, file_type, placeholders, status, version, created_at, updated_at'
    )
    .eq('domain_id', domainId)
    .order('updated_at', { ascending: false });

  if (error) {
    logger.error('[domain/templates] GET error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}

/**
 * POST — upload a new template. Admin-only.
 * Body: multipart/form-data with { file, name?, description? }
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }
  const file = formData.get('file');
  const nameInput = formData.get('name');
  const descriptionInput = formData.get('description');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 });
  }
  if (file.size > MAX_TEMPLATE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `Max template size ${MAX_TEMPLATE_MB} MB` }, { status: 400 });
  }
  const mime = file.type || 'application/octet-stream';
  const fileType = TEMPLATE_MIME_TO_TYPE[mime];
  if (!fileType) {
    return NextResponse.json(
      { error: `Ugyldig filtype: ${mime}. Tilladt: docx, pdf, txt.` },
      { status: 400 }
    );
  }

  const name =
    typeof nameInput === 'string' && nameInput.trim()
      ? nameInput.trim().slice(0, 200)
      : file.name.replace(/\.(docx|pdf|txt)$/i, '').slice(0, 200);
  const description =
    typeof descriptionInput === 'string' ? descriptionInput.trim().slice(0, 1000) : null;

  try {
    const arrayBuf = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const { path } = await uploadDomainFile(domainId, 'templates', file.name, buffer, mime);

    // Extract + detect placeholders
    const extraction = await extractTextFromBuffer(buffer, fileType as DomainFileType);
    const placeholders = extraction.ok ? detectPlaceholders(extraction.text) : [];
    // Store as JSONB — matches the domain_template.placeholders default '[]'
    const placeholderPayload = placeholders.map((p) => ({
      name: p.name,
      syntax: p.syntax,
      context: p.context,
      count: p.count,
    }));

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tplRow, error: insertErr } = (await (admin as any)
      .from('domain_template')
      .insert({
        domain_id: domainId,
        name,
        description,
        file_path: path,
        file_type: fileType,
        placeholders: placeholderPayload,
        status: 'active',
        version: 1,
        created_by: ctx.userId,
      })
      .select('id, name, description, file_type, placeholders, version, created_at')
      .single()) as { data: { id: string } | null; error: { message: string } | null };

    if (insertErr || !tplRow) {
      logger.error('[domain/templates] Insert error:', insertErr?.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // BIZZ-715: fire embedding worker — non-fatal on provider-missing
    if (extraction.ok && extraction.text) {
      try {
        await embedDomainSource(domainId, 'template', tplRow.id, extraction.text);
      } catch (embedErr) {
        logger.warn('[domain/templates] Embedding skipped:', embedErr);
      }
    }

    // Create initial version row so versioning (BIZZ-710) has a baseline
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('domain_template_version').insert({
      template_id: tplRow.id,
      version: 1,
      file_path: path,
      placeholders: placeholderPayload,
      created_by: ctx.userId,
      note: 'Initial upload',
    });

    // Audit
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('domain_audit_log').insert({
      domain_id: domainId,
      actor_user_id: ctx.userId,
      action: 'upload_template',
      target_type: 'template',
      target_id: tplRow.id,
      metadata: {
        name,
        file_type: fileType,
        size_bytes: buffer.length,
        placeholder_count: placeholders.length,
        parse_ok: extraction.ok,
      },
    });

    return NextResponse.json(
      {
        ...tplRow,
        extracted_text_preview: extraction.ok ? extraction.text.slice(0, 2000) : null,
        parse_ok: extraction.ok,
      },
      { status: 201 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    logger.error('[domain/templates] Upload error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
