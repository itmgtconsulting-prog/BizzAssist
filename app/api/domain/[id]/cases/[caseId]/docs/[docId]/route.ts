/**
 * Single case-doc API — signed download URL + soft-delete.
 *
 * BIZZ-713: Member-scoped. Soft-delete sets deleted_at timestamp (30-day
 * recovery window); physical file stays in storage until a follow-up cron
 * deletes it (out of scope for this ticket).
 *
 * GET    /api/domain/:id/cases/:caseId/docs/:docId — signed download URL
 * DELETE /api/domain/:id/cases/:caseId/docs/:docId — soft-delete
 *
 * @module api/domain/[id]/cases/[caseId]/docs/[docId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { getDomainFileUrl } from '@/app/lib/domainStorage';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string; caseId: string; docId: string }> };

async function fetchDoc(domainId: string, caseId: string, docId: string) {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('domain_case_doc')
    .select('id, case_id, file_path, name, deleted_at, case:case_id (domain_id)')
    .eq('id', docId)
    .eq('case_id', caseId)
    .maybeSingle();
  if (!data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dAny = data as any;
  if (dAny.case?.domain_id !== domainId) return null;
  return data as {
    id: string;
    case_id: string;
    file_path: string;
    name: string;
    deleted_at: string | null;
  };
}

/**
 * GET — return a signed download URL for the doc.
 * Signed URL expires after 15 minutes (per domainStorage default).
 */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, caseId, docId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const doc = await fetchDoc(domainId, caseId, docId);
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (doc.deleted_at) {
    return NextResponse.json({ error: 'Document has been deleted' }, { status: 410 });
  }
  try {
    const url = await getDomainFileUrl(domainId, doc.file_path);
    return NextResponse.json({ url, name: doc.name });
  } catch (err) {
    logger.error(
      '[domain/cases/docs/doc] Signed URL error:',
      err instanceof Error ? err.message : err
    );
    return NextResponse.json({ error: 'Could not generate download URL' }, { status: 500 });
  }
}

/**
 * DELETE — soft-delete (sets deleted_at). File stays in storage until a
 * separate retention cron hard-deletes rows older than 30 days (out of scope
 * for this ticket; tracked in BIZZ-719).
 */
export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, caseId, docId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const doc = await fetchDoc(domainId, caseId, docId);
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('domain_case_doc')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', docId);

  if (error) {
    logger.error('[domain/cases/docs/doc] Soft-delete error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'delete_case_doc',
    target_type: 'case_doc',
    target_id: docId,
    metadata: { case_id: caseId, name: doc.name },
  });

  return NextResponse.json({ ok: true });
}
