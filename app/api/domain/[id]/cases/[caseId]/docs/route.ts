/**
 * Domain Case Docs API — list + upload case documents.
 *
 * BIZZ-713: Member-scoped. Uploads go through domainStorage.uploadDomainFile()
 * which enforces the {domain_id}/… namespace (BIZZ-722 Lag 5). Caps:
 *   - 50 MB per file (enforced by domainStorage + here)
 *   - 50 active docs per case
 *
 * GET  /api/domain/:id/cases/:caseId/docs — list active docs
 * POST /api/domain/:id/cases/:caseId/docs — upload (multipart/form-data, key=file)
 *
 * @module api/domain/[id]/cases/[caseId]/docs
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { uploadDomainFile } from '@/app/lib/domainStorage';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string; caseId: string }> };

/** Max active docs per case (soft-deleted don't count). */
const MAX_DOCS_PER_CASE = 50;

/** MIME → file_type mapping matching domain_case_doc.file_type check constraint. */
const MIME_TO_TYPE: Record<string, 'docx' | 'pdf' | 'txt' | 'eml' | 'msg'> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'message/rfc822': 'eml',
  'application/vnd.ms-outlook': 'msg',
};

async function verifyCaseInDomain(domainId: string, caseId: string): Promise<boolean> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('domain_case')
    .select('id')
    .eq('id', caseId)
    .eq('domain_id', domainId)
    .maybeSingle();
  return !!data;
}

/**
 * POST — upload a document to the case.
 * Body: multipart/form-data with file field.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
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

  // Confirm case belongs to this domain — prevents crafted caseId crossing domains
  const owns = await verifyCaseInDomain(domainId, caseId);
  if (!owns) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Enforce 50 active docs per case
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = (await (admin as any)
    .from('domain_case_doc')
    .select('id', { count: 'exact', head: true })
    .eq('case_id', caseId)
    .is('deleted_at', null)) as { count: number | null };

  if ((count ?? 0) >= MAX_DOCS_PER_CASE) {
    return NextResponse.json(
      { error: `Maksimalt ${MAX_DOCS_PER_CASE} dokumenter pr. sag` },
      { status: 403 }
    );
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
  const mime = file.type || 'application/octet-stream';
  const fileType = MIME_TO_TYPE[mime];
  if (!fileType) {
    return NextResponse.json(
      { error: `Ugyldig filtype: ${mime}. Tilladt: docx, pdf, txt, eml, msg.` },
      { status: 400 }
    );
  }

  try {
    const arrayBuf = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const { path } = await uploadDomainFile(domainId, 'cases', file.name, buffer, mime);

    // Insert doc row
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: docRow, error: insertErr } = (await (admin as any)
      .from('domain_case_doc')
      .insert({
        case_id: caseId,
        name: file.name,
        file_path: path,
        file_type: fileType,
        size_bytes: buffer.length,
        uploaded_by: ctx.userId,
      })
      .select('id, name, file_path, file_type, size_bytes, created_at')
      .single()) as { data: { id: string } | null; error: { message: string } | null };

    if (insertErr || !docRow) {
      logger.error('[domain/cases/docs] Insert error:', insertErr?.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // Audit + bump case.updated_at
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('domain_audit_log').insert({
      domain_id: domainId,
      actor_user_id: ctx.userId,
      action: 'upload_case_doc',
      target_type: 'case_doc',
      target_id: docRow.id,
      metadata: {
        case_id: caseId,
        name: file.name,
        size_bytes: buffer.length,
        file_type: fileType,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('domain_case')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', caseId);

    return NextResponse.json(docRow, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    logger.error('[domain/cases/docs] Upload error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
