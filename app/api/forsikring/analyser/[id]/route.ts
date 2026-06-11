/**
 * GET /api/forsikring/analyser/[id] — Hent analyse-detaljer med aktiver + gaps + dokumenter + policer.
 *
 * BIZZ-1366: Returnerer fuld analyse med aktiver og gaps for UI-rendering.
 * BIZZ-1404: Tilføjer scoped dokumenter og policer via junction-tabel.
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
 * @returns Analyse + aktiver + gaps + documents + policies
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

    // Parallelt: hent analyse + aktiver + analyse-dokumenter
    const [analyseResult, aktiverResult, docLinksResult] = await Promise.all([
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
      db
        .from('forsikring_analyse_documents')
        .select('document_id, source')
        .eq('analyse_id', id)
        .eq('tenant_id', auth.tenantId),
    ]);

    if (analyseResult.error || !analyseResult.data) {
      return NextResponse.json({ error: 'Analyse ikke fundet' }, { status: 404 });
    }

    // BIZZ-1404: Hent scoped dokumenter via junction-tabel
    const docLinks = (docLinksResult.data ?? []) as Array<{ document_id: string; source: string }>;
    const docIds = docLinks.map((l) => l.document_id);
    const sourceMap = new Map(docLinks.map((l) => [l.document_id, l.source]));

    let documents: unknown[] = [];
    let policies: unknown[] = [];

    if (docIds.length > 0) {
      // Hent dokumenter + policer der hører til disse dokumenter
      const [docsResult, policiesResult] = await Promise.all([
        db
          .from('forsikring_documents')
          .select('id, original_name, parse_status, parse_error, created_at')
          .in('id', docIds)
          .eq('tenant_id', auth.tenantId),
        db
          .from('forsikring_policies')
          .select('*')
          .in('document_id', docIds)
          .eq('tenant_id', auth.tenantId)
          .order('created_at', { ascending: false }),
      ]);

      documents = (docsResult.data ?? []).map((d: Record<string, unknown>) => ({
        ...d,
        source: sourceMap.get(d.id as string) ?? 'uploaded',
      }));
      policies = policiesResult.data ?? [];
    }

    // Hent gaps — prefer analyse_id scoped, fallback til policy_id for legacy
    const matchedPolicyIds = (aktiverResult.data ?? [])
      .map((a: { matched_policy_id: string | null }) => a.matched_policy_id)
      .filter(Boolean) as string[];

    let gaps: unknown[] = [];

    // Først: prøv analyse-scoped gaps
    const { data: scopedGaps } = await db
      .from('forsikring_gaps')
      .select('*')
      .eq('analyse_id', id)
      .eq('tenant_id', auth.tenantId)
      .order('severity', { ascending: true });

    if (scopedGaps && scopedGaps.length > 0) {
      gaps = scopedGaps;
    } else if (matchedPolicyIds.length > 0) {
      // Fallback: legacy gaps uden analyse_id (fra parse-time)
      const { data: legacyGaps } = await db
        .from('forsikring_gaps')
        .select('*')
        .in('policy_id', [...new Set(matchedPolicyIds)])
        .eq('tenant_id', auth.tenantId)
        .order('severity', { ascending: true });
      gaps = legacyGaps ?? [];
    }

    // BIZZ-2084: Hent dækninger for de matchede policer, så UI'et kan vise
    // med grønt hvad der ER dækket (inkl. dækningssum + selvrisiko) — ikke
    // kun manglerne. Bruges til at reviewe dækningsniveauet med kunden.
    let coverages: unknown[] = [];
    if (matchedPolicyIds.length > 0) {
      const { data: coverageRows } = await db
        .from('forsikring_coverages')
        .select('policy_id, coverage_code, coverage_label, is_covered, sum_dkk, deductible_dkk')
        .in('policy_id', [...new Set(matchedPolicyIds)])
        .eq('tenant_id', auth.tenantId)
        .order('coverage_label', { ascending: true });
      coverages = coverageRows ?? [];
    }

    return NextResponse.json({
      analyse: analyseResult.data,
      aktiver: aktiverResult.data ?? [],
      gaps,
      documents,
      policies,
      coverages,
    });
  } catch (err) {
    logger.error('[forsikring/analyser/[id]] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
