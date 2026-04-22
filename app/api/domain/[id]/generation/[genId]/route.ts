/**
 * Generation detail — GET metadata + signed preview URL.
 *
 * BIZZ-717: Member-scoped. Returns domain_generation row + a 15-min
 * signed URL to the output file (when status = completed).
 *
 * @module api/domain/[id]/generation/[genId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { getDomainFileUrl } from '@/app/lib/domainStorage';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string; genId: string }> };

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
    .select(
      'id, case_id, template_id, status, output_path, claude_tokens, user_prompt, error_message, started_at, completed_at, requested_by, created_at, case:case_id (domain_id)'
    )
    .eq('id', genId)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Verify domain-scope via the join (BIZZ-722 defense-in-depth)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any;
  if (row.case?.domain_id !== domainId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let previewUrl: string | null = null;
  if (row.status === 'completed' && row.output_path) {
    try {
      previewUrl = await getDomainFileUrl(domainId, row.output_path);
    } catch (err) {
      logger.warn('[domain/generation] Signed URL failed:', err);
    }
  }

  // Remove the joined case object from the response — the client only needs
  // the generation fields + the preview URL.

  const { case: _case, ...rest } = row;
  return NextResponse.json({ ...rest, preview_url: previewUrl });
}
