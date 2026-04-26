/**
 * Attach a completed generation's output to its case as a case-doc.
 *
 * BIZZ-803: The generation's output file already lives in storage at
 * `{domainId}/generated/{genId}.{ext}`. When the user clicks "Godkend
 * og gem" in the preview panel, we:
 *   1. Copy the file into the case-docs area so it follows the same
 *      lifecycle as uploaded docs (retention, soft-delete, embeddings).
 *   2. Insert a `domain_case_doc` row pointing at the new path.
 *   3. Audit-log the action.
 *
 * Idempotent: if the generation has already been attached, returns
 * 200 with `{ already: true }` instead of creating a duplicate.
 *
 * @module api/domain/[id]/generation/[genId]/attach-to-case
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { uploadDomainFile } from '@/app/lib/domainStorage';
import { resolveFileType } from '@/app/lib/domainFileTypes';
import { extractTextFromBuffer } from '@/app/lib/domainTextExtraction';
import { embedDomainSource } from '@/app/lib/domainEmbeddingWorker';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string; genId: string }> };

export async function POST(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, genId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: genRow } = await (admin as any)
    .from('domain_generation')
    .select(
      'id, case_id, status, output_path, template_id, attached_case_doc_id, case:case_id (domain_id, name), template:template_id (name)'
    )
    .eq('id', genId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = genRow as any;
  if (!row || row.case?.domain_id !== domainId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (row.status !== 'completed' || !row.output_path) {
    return NextResponse.json({ error: 'Generation is not completed' }, { status: 409 });
  }
  // Idempotency: the generation may already have been attached. We stash
  // the resulting doc id in domain_generation.metadata (JSONB) on first
  // attach — but for now, just look for an existing case-doc that
  // references this generation in its name to avoid duplicates in the
  // common happy path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (admin as any)
    .from('domain_case_doc')
    .select('id')
    .eq('case_id', row.case_id)
    .eq('generation_id', genId)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ already: true, doc_id: existing.id });
  }

  // Download the generated file
  const { data: file, error: dlErr } = await admin.storage
    .from('domain-files')
    .download(row.output_path);
  if (dlErr || !file) {
    logger.warn('[attach-to-case] download failed:', dlErr?.message);
    return NextResponse.json({ error: 'Download failed' }, { status: 500 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = row.output_path.split('.').pop()?.toLowerCase() ?? 'docx';
  const fileType = resolveFileType(undefined, row.output_path) ?? 'docx';
  const templateName =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (row.template as any)?.name ?? 'generated';
  const displayName = `${templateName}.${ext}`;
  const mime =
    fileType === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : fileType === 'pdf'
        ? 'application/pdf'
        : 'application/octet-stream';

  // Upload into the cases/ area so it's co-located with other case docs
  const { path } = await uploadDomainFile(domainId, 'cases', displayName, buffer, mime);

  // Extract text so it gets picked up by future AI generations that
  // reference this case. Non-fatal if extraction fails.
  const extraction = await extractTextFromBuffer(buffer, fileType);
  const extractedText = extraction.ok ? extraction.text : null;
  const parseStatus = extraction.ok ? (extraction.truncated ? 'truncated' : 'ok') : 'failed';
  const parseError = extraction.ok ? null : extraction.error.slice(0, 500);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: docRow, error: insErr } = (await (admin as any)
    .from('domain_case_doc')
    .insert({
      case_id: row.case_id,
      name: displayName,
      file_path: path,
      file_type: fileType,
      size_bytes: buffer.length,
      uploaded_by: ctx.userId,
      extracted_text: extractedText,
      parse_status: parseStatus,
      parse_error: parseError,
      generation_id: genId,
    })
    .select('id')
    .single()) as { data: { id: string } | null; error: { message: string } | null };

  if (insErr || !docRow) {
    logger.error('[attach-to-case] insert failed:', insErr?.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  if (extractedText) {
    try {
      await embedDomainSource(domainId, 'case_doc', docRow.id, extractedText);
    } catch (err) {
      logger.warn('[attach-to-case] embedding skipped:', err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'attach_generation_to_case',
    target_type: 'case_doc',
    target_id: docRow.id,
    metadata: { generation_id: genId, case_id: row.case_id },
  });

  return NextResponse.json({ ok: true, doc_id: docRow.id }, { status: 201 });
}
