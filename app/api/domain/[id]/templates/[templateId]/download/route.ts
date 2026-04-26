/**
 * BIZZ-797: Download skabelon-fil (current version by default, eller en
 * specifik version via ?version=N query param).
 *
 *   GET /api/domain/[id]/templates/[templateId]/download
 *     → redirect til signed URL for current version
 *   GET /api/domain/[id]/templates/[templateId]/download?version=3
 *     → redirect til signed URL for version 3
 *
 * Member-scoped. Signed URL udstedes med 15 min udløb (samme som resten af
 * domainStorage). Client sætter et kort <a download> attribut så browseren
 * trigger en download i stedet for at åbne i-browser.
 *
 * @module api/domain/[id]/templates/[templateId]/download
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { getDomainFileUrl } from '@/app/lib/domainStorage';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string; templateId: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, templateId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const versionParam = request.nextUrl.searchParams.get('version');
  const admin = createAdminClient();

  let filePath: string | null = null;
  let downloadName: string | null = null;

  if (versionParam) {
    const versionNum = Number(versionParam);
    if (!Number.isInteger(versionNum) || versionNum < 1) {
      return NextResponse.json({ error: 'Invalid version' }, { status: 400 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = (await (admin as any)
      .from('domain_template_version')
      .select('file_path')
      .eq('template_id', templateId)
      .eq('version', versionNum)
      .maybeSingle()) as { data: { file_path: string } | null };
    filePath = data?.file_path ?? null;
  } else {
    // Default: current version on the template row
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = (await (admin as any)
      .from('domain_template')
      .select('file_path, name')
      .eq('id', templateId)
      .eq('domain_id', domainId)
      .maybeSingle()) as { data: { file_path: string; name: string } | null };
    filePath = data?.file_path ?? null;
    downloadName = data?.name ?? null;
  }

  if (!filePath) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  // Cross-domain guard: path must belong to this domain's storage namespace.
  if (!filePath.startsWith(`${domainId}/`)) {
    logger.warn('[domain/templates/download] path mismatch:', { domainId, filePath });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const signedUrl = await getDomainFileUrl(domainId, filePath);
    // 302 redirect to the signed URL — browseren håndterer download.
    const res = NextResponse.redirect(signedUrl, { status: 302 });
    if (downloadName) {
      res.headers.set('Content-Disposition', `attachment; filename="${downloadName}"`);
    }
    return res;
  } catch (err) {
    logger.warn('[domain/templates/download] signed URL error:', err);
    return NextResponse.json({ error: 'Kunne ikke generere download-link' }, { status: 500 });
  }
}
