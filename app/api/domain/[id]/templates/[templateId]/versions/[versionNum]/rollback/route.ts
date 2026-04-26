/**
 * Template version rollback — admin-only.
 *
 * BIZZ-710: Promotes an older domain_template_version row back to the
 * current state on domain_template. Does NOT delete newer versions —
 * they stay in the version history so admins can roll forward again.
 *
 * POST /api/domain/:id/templates/:tid/versions/:versionNum/rollback
 *
 * @module api/domain/[id]/templates/[templateId]/versions/[versionNum]/rollback
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainAdmin } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = {
  params: Promise<{ id: string; templateId: string; versionNum: string }>;
};

export async function POST(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: domainId, templateId, versionNum } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const targetVersion = parseInt(versionNum, 10);
  if (!Number.isFinite(targetVersion) || targetVersion < 1) {
    return NextResponse.json({ error: 'Invalid version number' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify template belongs to this domain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: tpl } = await (admin as any)
    .from('domain_template')
    .select('id, version')
    .eq('id', templateId)
    .eq('domain_id', domainId)
    .maybeSingle();
  if (!tpl) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Fetch target version row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: version } = await (admin as any)
    .from('domain_template_version')
    .select('id, version, file_path, placeholders, instructions, examples, note')
    .eq('template_id', templateId)
    .eq('version', targetVersion)
    .maybeSingle();
  if (!version) {
    return NextResponse.json({ error: 'Version not found' }, { status: 404 });
  }

  // Promote: bump version number (so rollback itself is tracked as a new
  // current version) and copy file_path + placeholders back onto
  // domain_template. We DON'T decrement — rolling back to v3 after a
  // mistake in v5 should show as v6 pointing to v3's file.
  const promoted = Number((tpl as { version: number }).version) + 1;
  const v = version as {
    version: number;
    file_path: string;
    placeholders: unknown;
    instructions: string | null;
    examples: unknown;
    note: string | null;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateErr } = await (admin as any)
    .from('domain_template')
    .update({
      version: promoted,
      file_path: v.file_path,
      placeholders: v.placeholders,
      instructions: v.instructions,
      examples: v.examples,
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId);

  if (updateErr) {
    logger.error('[domain/templates/rollback] Update error:', updateErr.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // Insert a new version row recording the rollback so the audit trail is clean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_template_version').insert({
    template_id: templateId,
    version: promoted,
    file_path: v.file_path,
    placeholders: v.placeholders,
    instructions: v.instructions,
    examples: v.examples,
    created_by: ctx.userId,
    note: `Rollback to v${targetVersion}${v.note ? ` — ${v.note}` : ''}`,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'rollback_template_version',
    target_type: 'template',
    target_id: templateId,
    metadata: { rolled_back_to: targetVersion, new_version: promoted },
  });

  return NextResponse.json({ ok: true, new_version: promoted });
}
