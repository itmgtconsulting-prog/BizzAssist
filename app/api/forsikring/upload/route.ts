/**
 * POST /api/forsikring/upload
 *
 * Upload én forsikrings-PDF. Filen lagres i Supabase Storage bucket
 * `forsikring-documents` under path `{tenant_id}/{uuid}-{sanitized_name}.pdf`,
 * og der oprettes en række i `forsikring_documents` med parse_status=pending.
 *
 * Upload trigger ikke parsing automatisk — frontend kalder efterfølgende
 * `POST /api/forsikring/parse` med dokument-id'et. Det giver os mulighed
 * for at vise upload-status separat fra parse-status og at re-parse uden
 * re-upload.
 *
 * Body: multipart/form-data med felt 'file' (application/pdf, max 20 MB)
 *
 * @returns { document: { id, original_name, size_bytes, parse_status } }
 *
 * @module api/forsikring/upload
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import { getInsuranceApi } from '@/lib/db/insurance';
import { getTenantContext } from '@/lib/db/tenant';
import { sanitizeFilename } from '@/app/lib/aiFileGeneration';
import { resolveFileType, supportedLabels } from '@/app/lib/domainFileTypes';

/** 20 MB hard cap matchende storage bucket file_size_limit */
const MAX_BYTES = 20 * 1024 * 1024;

/** Storage bucket name */
const BUCKET = 'forsikring-documents';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limited = await checkRateLimit(request, heavyRateLimit);
  if (limited) return limited;

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
  if (file.size === 0) {
    return NextResponse.json({ error: 'Filen er tom' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Filen er for stor (max ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 413 }
    );
  }
  const mime = file.type || 'application/octet-stream';
  const fileType = resolveFileType(mime, file.name);
  if (!fileType) {
    return NextResponse.json(
      { error: `Ugyldig filtype. Tilladt: ${supportedLabels()}.` },
      { status: 400 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const safeName = sanitizeFilename(file.name);
    // Path-konvention: {tenant_id}/{uuid}-{safeName}
    const storagePath = `${auth.tenantId}/${randomUUID()}-${safeName}`;

    const admin = createAdminClient();
    const { error: uploadErr } = await admin.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: mime,
      upsert: false,
    });
    if (uploadErr) {
      logger.error('[forsikring/upload] storage fejl:', uploadErr.message);
      return NextResponse.json({ error: 'Upload fejlede' }, { status: 500 });
    }

    // Opret række i forsikring_documents
    const insurance = await getInsuranceApi(auth.tenantId);
    const doc = await insurance.documents.create({
      storage_path: storagePath,
      original_name: file.name,
      mime_type: mime,
      size_bytes: file.size,
      uploaded_by: auth.userId,
    });

    // Audit log
    const ctx = await getTenantContext(auth.tenantId);
    await ctx.auditLog.write({
      action: 'forsikring.document.uploaded',
      resource_type: 'forsikring_document',
      resource_id: doc.id,
      metadata: { size_bytes: file.size },
    });

    return NextResponse.json({
      document: {
        id: doc.id,
        original_name: doc.original_name,
        size_bytes: doc.size_bytes,
        parse_status: doc.parse_status,
        created_at: doc.created_at,
      },
    });
  } catch (err) {
    logger.error('[forsikring/upload] uventet fejl:', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
