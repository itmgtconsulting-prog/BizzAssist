/**
 * Generation download — signed URL for the output docx.
 *
 * BIZZ-717: Same policy as /generation/:id GET — member-scoped +
 * domain-verified via case join.
 *
 * @module api/domain/[id]/generation/[genId]/download
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { getDomainFileUrl } from '@/app/lib/domainStorage';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';

type RouteContext = { params: Promise<{ id: string; genId: string }> };

export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
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
  const { data } = await (admin as any)
    .from('domain_generation')
    .select('id, status, output_path, case:case_id (domain_id)')
    .eq('id', genId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any;
  if (!row || row.case?.domain_id !== domainId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (row.status !== 'completed' || !row.output_path) {
    return NextResponse.json({ error: 'Generation not ready' }, { status: 409 });
  }

  try {
    const url = await getDomainFileUrl(domainId, row.output_path);
    // Audit the download separately so sharing-the-URL use cases can be
    // traced. (The URL itself is time-limited — 15 min default.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('domain_audit_log').insert({
      domain_id: domainId,
      actor_user_id: ctx.userId,
      action: 'download_generation',
      target_type: 'generation',
      target_id: genId,
    });
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'URL generation failed' },
      { status: 500 }
    );
  }
}
