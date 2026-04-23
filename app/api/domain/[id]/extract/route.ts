/**
 * BIZZ-795: Domain file-text extraction endpoint.
 *
 * Accepts a multipart upload and returns extracted plain text so the admin
 * UI can use a file as a template "example" (Eksempler-tab) without first
 * saving it to the knowledge-base. The file is parsed in memory and the
 * result is returned — nothing is persisted.
 *
 *   POST /api/domain/[id]/extract
 *     body: multipart/form-data with { file }
 *     returns: { text: string, truncated: boolean, file_type: string }
 *
 * Member-scoped (not admin-only) because it's a non-mutating helper. File
 * is validated via resolveFileType() with the same allowlist as all other
 * upload endpoints.
 *
 * @module api/domain/[id]/extract
 */

import { NextRequest, NextResponse } from 'next/server';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { resolveFileType, supportedLabels, isExtractable } from '@/app/lib/domainFileTypes';
import { extractTextFromBuffer } from '@/app/lib/domainTextExtraction';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/** Max file size for extraction: 20 MB (same as training/template uploads). */
const MAX_MB = 20;

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId } = await context.params;
  try {
    await assertDomainMember(domainId);
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
  if (file.size > MAX_MB * 1024 * 1024) {
    return NextResponse.json({ error: `Max file size ${MAX_MB} MB` }, { status: 400 });
  }
  const mime = file.type || 'application/octet-stream';
  const fileType = resolveFileType(mime, file.name);
  if (!fileType) {
    return NextResponse.json(
      { error: `Ugyldig filtype: ${mime}. Tilladt: ${supportedLabels()}.` },
      { status: 400 }
    );
  }
  if (!isExtractable(fileType)) {
    return NextResponse.json(
      { error: 'Billeder kan ikke bruges som eksempel — upload en tekst-fil.' },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const extraction = await extractTextFromBuffer(buffer, fileType);
  if (!extraction.ok) {
    return NextResponse.json(
      { error: extraction.error ?? 'Kunne ikke læse filen' },
      { status: 400 }
    );
  }

  return NextResponse.json({
    text: extraction.text,
    truncated: extraction.truncated,
    file_type: fileType,
  });
}
