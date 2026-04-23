/**
 * Domain Training Docs API — list + upload training documents.
 *
 * BIZZ-709: Training docs are context material the AI pipeline consumes at
 * every generation (internal guidelines, fagterminologi, legal precedents).
 * Separate from templates because they are NOT output skeletons.
 *
 * Admin-only for writes. Members can read so the generation pipeline
 * (BIZZ-716) can list them when composing the RAG context.
 *
 * Pipeline on upload: storage → text extract → insert row with parse_status.
 * No placeholder detection (training docs aren't filled — only retrieved).
 *
 * @module api/domain/[id]/training-docs
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember, assertDomainAdmin } from '@/app/lib/domainAuth';
import { uploadDomainFile } from '@/app/lib/domainStorage';
import { extractTextFromBuffer } from '@/app/lib/domainTextExtraction';
import { resolveFileType, supportedLabels } from '@/app/lib/domainFileTypes';
import { embedDomainSource } from '@/app/lib/domainEmbeddingWorker';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/** Training-doc max size: 20 MB (same as templates — keeps RAG context bounded). */
const MAX_TRAINING_MB = 20;
const VALID_DOC_TYPES = new Set(['guide', 'policy', 'reference', 'example']);
// BIZZ-788: file-type validation centraliseret i app/lib/domainFileTypes.ts.

/** GET — list training docs with tags + filter by doc_type (optional). */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const docType = request.nextUrl.searchParams.get('doc_type');

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (admin as any)
    .from('domain_training_doc')
    .select('id, name, description, doc_type, tags, parse_status, parse_error, created_at')
    .eq('domain_id', domainId)
    .order('created_at', { ascending: false });

  if (docType && VALID_DOC_TYPES.has(docType)) {
    q = q.eq('doc_type', docType);
  }

  const { data, error } = await q;
  if (error) {
    logger.error('[domain/training-docs] GET error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}

/**
 * POST — upload a training document. Admin-only.
 * Body: multipart/form-data with { file, name?, description?, doc_type?, tags? }
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
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 });
  }
  if (file.size > MAX_TRAINING_MB * 1024 * 1024) {
    return NextResponse.json(
      { error: `Max training-doc size ${MAX_TRAINING_MB} MB` },
      { status: 400 }
    );
  }
  const mime = file.type || 'application/octet-stream';
  const fileType = resolveFileType(mime, file.name);
  if (!fileType) {
    return NextResponse.json(
      { error: `Ugyldig filtype: ${mime}. Tilladt: ${supportedLabels()}.` },
      { status: 400 }
    );
  }

  const nameInput = formData.get('name');
  const descriptionInput = formData.get('description');
  const docTypeInput = formData.get('doc_type');
  const tagsInput = formData.get('tags');

  const name =
    typeof nameInput === 'string' && nameInput.trim()
      ? nameInput.trim().slice(0, 200)
      : file.name.replace(/\.[^.]+$/, '').slice(0, 200);
  const description =
    typeof descriptionInput === 'string' ? descriptionInput.trim().slice(0, 1000) : null;
  const docType =
    typeof docTypeInput === 'string' && VALID_DOC_TYPES.has(docTypeInput) ? docTypeInput : 'guide';
  const tags =
    typeof tagsInput === 'string'
      ? tagsInput
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { path } = await uploadDomainFile(domainId, 'training', file.name, buffer, mime);
    const extraction = await extractTextFromBuffer(buffer, fileType);
    const parseStatus = extraction.ok ? (extraction.truncated ? 'truncated' : 'ok') : 'failed';

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row, error: insertErr } = (await (admin as any)
      .from('domain_training_doc')
      .insert({
        domain_id: domainId,
        name,
        description,
        file_path: path,
        doc_type: docType,
        tags,
        extracted_text: extraction.ok ? extraction.text : null,
        parse_status: parseStatus,
        parse_error: extraction.ok ? null : extraction.error.slice(0, 500),
        created_by: ctx.userId,
      })
      .select('id, name, doc_type, tags, parse_status, created_at')
      .single()) as { data: { id: string } | null; error: { message: string } | null };

    if (insertErr || !row) {
      logger.error('[domain/training-docs] Insert error:', insertErr?.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // BIZZ-715: fire embedding worker — non-fatal on provider-missing
    if (extraction.ok && extraction.text) {
      try {
        await embedDomainSource(domainId, 'training', row.id, extraction.text);
      } catch (embedErr) {
        logger.warn('[domain/training-docs] Embedding skipped:', embedErr);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('domain_audit_log').insert({
      domain_id: domainId,
      actor_user_id: ctx.userId,
      action: 'upload_training_doc',
      target_type: 'training_doc',
      target_id: row.id,
      metadata: {
        name,
        doc_type: docType,
        file_type: fileType,
        size_bytes: buffer.length,
        parse_status: parseStatus,
      },
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    logger.error('[domain/training-docs] Upload error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
