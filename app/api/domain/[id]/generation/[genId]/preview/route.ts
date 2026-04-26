/**
 * Generation preview — returns the extracted text of a completed
 * generation so the workspace can render an in-app preview without
 * asking the user to download the .docx.
 *
 * BIZZ-803: Member-scoped. Uses the same extractTextFromBuffer helper
 * as case-doc uploads so format support is identical. Truncates to
 * 20k chars so the preview JSON stays light.
 *
 * @module api/domain/[id]/generation/[genId]/preview
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { extractTextFromBuffer } from '@/app/lib/domainTextExtraction';
import { resolveFileType } from '@/app/lib/domainFileTypes';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string; genId: string }> };

const MAX_PREVIEW_CHARS = 20_000;

export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, genId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('domain_generation')
    .select('id, output_path, status, case:case_id (domain_id)')
    .eq('id', genId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any;
  if (!row || row.case?.domain_id !== domainId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (row.status !== 'completed' || !row.output_path) {
    return NextResponse.json({ error: 'Not ready' }, { status: 409 });
  }

  try {
    const { data: file, error } = await admin.storage
      .from('domain-files')
      .download(row.output_path);
    if (error || !file) {
      logger.warn('[generation/preview] download failed:', error?.message);
      return NextResponse.json({ error: 'Download failed' }, { status: 500 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    // Derive type from extension of output_path
    const type = resolveFileType(undefined, row.output_path);
    if (!type) {
      return NextResponse.json({ text: '', truncated: false });
    }
    const res = await extractTextFromBuffer(buf, type);
    if (!res.ok) {
      return NextResponse.json({ text: '', truncated: false, error: res.error });
    }
    const text = res.text.slice(0, MAX_PREVIEW_CHARS);
    return NextResponse.json({
      text,
      truncated: res.text.length > MAX_PREVIEW_CHARS,
      file_type: type,
    });
  } catch (err) {
    logger.warn('[generation/preview] unexpected:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
