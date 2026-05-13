/**
 * GET /api/forsikring/analyser/[id] — Hent analyse-detaljer med aktiver + gaps.
 *
 * BIZZ-1366: Returnerer fuld analyse med aktiver og gaps for UI-rendering.
 *
 * @module api/forsikring/analyser/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

/**
 * GET /api/forsikring/analyser/[id]
 *
 * @param request - Next.js request
 * @param params - Route params med analyse-ID
 * @returns Analyse + aktiver + gaps
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing analyse id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Parallelt: hent analyse + aktiver
    const [analyseResult, aktiverResult] = await Promise.all([
      db
        .from('forsikring_analyser')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', auth.tenantId)
        .maybeSingle(),
      db
        .from('forsikring_aktiver')
        .select('*')
        .eq('analyse_id', id)
        .eq('tenant_id', auth.tenantId)
        .order('type', { ascending: true }),
    ]);

    if (analyseResult.error || !analyseResult.data) {
      return NextResponse.json({ error: 'Analyse ikke fundet' }, { status: 404 });
    }

    // Hent gaps for matchede policer
    const matchedPolicyIds = (aktiverResult.data ?? [])
      .map((a: { matched_policy_id: string | null }) => a.matched_policy_id)
      .filter(Boolean) as string[];

    let gaps: unknown[] = [];
    if (matchedPolicyIds.length > 0) {
      const { data: gapRows } = await db
        .from('forsikring_gaps')
        .select('*')
        .in('policy_id', [...new Set(matchedPolicyIds)])
        .eq('tenant_id', auth.tenantId)
        .order('severity', { ascending: true });
      gaps = gapRows ?? [];
    }

    return NextResponse.json({
      analyse: analyseResult.data,
      aktiver: aktiverResult.data ?? [],
      gaps,
    });
  } catch (err) {
    logger.error('[forsikring/analyser/[id]] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
