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
    // BIZZ-1439: Dedup-check — skip upload+parse hvis samme filnavn+størrelse allerede eksisterer
    const insuranceForDedup = await getInsuranceApi(auth.tenantId);
    const existingDocs = await insuranceForDedup.documents.list();
    // BIZZ-2008: Also dedup against 'processing' docs to prevent race condition
    // when same file is uploaded twice in quick succession
    const duplicate = existingDocs.find(
      (d) =>
        d.original_name === file.name &&
        d.size_bytes === file.size &&
        (d.parse_status === 'parsed' || d.parse_status === 'parsing')
    );
    if (duplicate) {
      logger.log(
        `[forsikring/upload] Dedup: ${file.name} (${file.size}B) allerede uploaded som ${duplicate.id}`
      );
      return NextResponse.json({
        document: { id: duplicate.id },
        deduplicated: true,
      });
    }

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
      logger.error(
        `[forsikring/upload] Storage fejl for "${file.name}" (${file.size}B, mime=${mime}): ${uploadErr.message}`
      );
      return NextResponse.json({ error: `Upload fejlede: ${uploadErr.message}` }, { status: 500 });
    }
    logger.log(
      `[forsikring/upload] OK "${file.name}" → ${storagePath} (${buffer.length}B, type=${fileType})`
    );

    // BIZZ-1399: Optionelt sag_id fra FormData
    const sagId = formData.get('sag_id');
    const sagIdStr = typeof sagId === 'string' && sagId.length > 0 ? sagId : undefined;
    // BIZZ-1632: kunde_id for at isolere dokumenter per kunde
    const kundeId = formData.get('kunde_id');
    const kundeIdStr = typeof kundeId === 'string' && kundeId.length > 0 ? kundeId : undefined;

    // Opret række i forsikring_documents
    const insurance = await getInsuranceApi(auth.tenantId);
    const doc = await insurance.documents.create({
      storage_path: storagePath,
      original_name: file.name,
      mime_type: mime,
      size_bytes: file.size,
      uploaded_by: auth.userId,
      sag_id: sagIdStr,
      kunde_id: kundeIdStr,
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
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[forsikring/upload] CRASH "${file.name}": ${msg}`);
    return NextResponse.json({ error: `Serverfejl: ${msg}` }, { status: 500 });
  }
}
