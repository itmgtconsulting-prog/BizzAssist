/**
 * GDPR export-all — downloads every row for a domain as a single JSON
 * document.
 *
 * BIZZ-719: Admin-only. Produces a structured JSON export with:
 *   - domain row
 *   - members
 *   - templates + versions
 *   - training_docs
 *   - cases + case_docs + generations
 *   - audit log (recent 5000 entries)
 *
 * Storage files are NOT inlined (too big); the export references them
 * via file_path so admins can fetch them separately via signed URLs.
 * A future enhancement (BIZZ-719.1) could bundle everything into a ZIP.
 *
 * @module api/domain/[id]/admin/export-all
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainAdmin } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  try {
    // Tables fetched in parallel to keep the endpoint snappy
    const queries = [
      ['domain', 'id', '=', domainId, 'maybeSingle'],
      ['domain_member', 'domain_id', '=', domainId, 'all'],
      ['domain_template', 'domain_id', '=', domainId, 'all'],
      ['domain_training_doc', 'domain_id', '=', domainId, 'all'],
      ['domain_case', 'domain_id', '=', domainId, 'all'],
    ] as const;

    // Run the base queries

    const [domainR, membersR, templatesR, trainingR, casesR] = await Promise.all(
      queries.map(async (q) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const builder = (admin as any).from(q[0]).select('*').eq(q[1], q[3]);
        return q[4] === 'maybeSingle' ? builder.maybeSingle() : builder;
      })
    );

    const caseIds = ((casesR.data ?? []) as Array<{ id: string }>).map((c) => c.id);

    const [caseDocsR, generationsR, templateVersionsR, auditR] = await Promise.all([
      caseIds.length > 0
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (admin as any).from('domain_case_doc').select('*').in('case_id', caseIds)
        : Promise.resolve({ data: [] }),
      caseIds.length > 0
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (admin as any).from('domain_generation').select('*').in('case_id', caseIds)
        : Promise.resolve({ data: [] }),
      (templatesR.data ?? []).length > 0
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (admin as any)
            .from('domain_template_version')
            .select('*')
            .in(
              'template_id',
              ((templatesR.data ?? []) as Array<{ id: string }>).map((t) => t.id)
            )
        : Promise.resolve({ data: [] }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any)
        .from('domain_audit_log')
        .select('*')
        .eq('domain_id', domainId)
        .order('created_at', { ascending: false })
        .limit(5000),
    ]);

    const exportPayload = {
      export_version: '1',
      exported_at: new Date().toISOString(),
      exported_by: ctx.userId,
      note: 'BIZZ-719 GDPR portability export. Storage files are referenced by file_path but not inlined — use /api/domain/:id/cases/:caseId/docs/:docId to fetch signed download URLs.',
      domain: domainR.data,
      members: membersR.data ?? [],
      templates: templatesR.data ?? [],
      template_versions: templateVersionsR.data ?? [],
      training_docs: trainingR.data ?? [],
      cases: casesR.data ?? [],
      case_docs: caseDocsR.data ?? [],
      generations: generationsR.data ?? [],
      audit_log: auditR.data ?? [],
    };

    // Audit the export itself
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('domain_audit_log').insert({
      domain_id: domainId,
      actor_user_id: ctx.userId,
      action: 'export_all',
      target_type: 'domain',
      target_id: domainId,
      metadata: {
        cases: (casesR.data ?? []).length,
        templates: (templatesR.data ?? []).length,
        audit_entries: (auditR.data ?? []).length,
      },
    });

    return new NextResponse(JSON.stringify(exportPayload, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="domain-${domainId}-export.json"`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[domain/export-all] Error:', msg);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
