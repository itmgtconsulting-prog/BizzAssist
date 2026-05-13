/**
 * POST /api/forsikring/analyser — Kør gap-analyse for en kunde.
 * GET  /api/forsikring/analyser — List alle analyser for tenant.
 *
 * BIZZ-1366: Walk koncern → match aktiver mod policer → kør gap-engine
 * → persistér i forsikring_analyser + forsikring_aktiver + forsikring_gaps.
 *
 * @module api/forsikring/analyser
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { getInsuranceApi } from '@/lib/db/insurance';
import { walkKoncern } from '@/app/lib/forsikring/koncernWalk';
import { matchAssetsToPolicies } from '@/app/lib/forsikring/assetMatcher';
import { runGapEngine, computeRiskScore } from '@/app/lib/forsikring/gapEngine';
import { logActivity } from '@/app/lib/activityLog';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

/**
 * POST /api/forsikring/analyser
 *
 * Body: { kunde_type: 'virksomhed'|'person', kunde_id: string }
 *
 * @param request - Next.js request
 * @returns { analyse_id: string }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { kunde_type: string; kunde_id: string; kunde_navn?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { kunde_type, kunde_id, kunde_navn } = body;
  if (!kunde_type || !kunde_id || !['virksomhed', 'person'].includes(kunde_type)) {
    return NextResponse.json({ error: 'Missing or invalid kunde_type/kunde_id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // 1. Walk koncern → opdag aktiver
    logger.log(`[forsikring/analyser] Walking koncern for ${kunde_type} ${kunde_id}`);
    const aktiver = await walkKoncern(kunde_type as 'virksomhed' | 'person', kunde_id);
    logger.log(`[forsikring/analyser] Fandt ${aktiver.length} aktiver`);

    // 2. Hent policer fra tenant
    const insurance = await getInsuranceApi(auth.tenantId);
    const policer = await insurance.policies.list();

    // 3. Match aktiver mod policer
    const matches = matchAssetsToPolicies(aktiver, policer);
    const insuredCount = matches.filter((m) => m.bestMatch !== null).length;

    // 4. Kør gap-engine for matchede aktiver
    const allGaps: Array<{
      policyId: string;
      checkId: string;
      category: string;
      severity: string;
      title: string;
      description: string;
      recommendation: string | null;
      estimatedImpactDkk: number | null;
      sourceData: Record<string, unknown>;
      riskScore: number;
    }> = [];

    for (const match of matches) {
      if (!match.bestMatch) continue;
      const gaps = runGapEngine({
        policy: match.bestMatch.policy,
        coverages: [], // TODO: hent coverages per policy
        bbr: null,
        asOfDate: new Date(),
        asset: {
          type: match.aktiv.type,
          vaerdiDkk: match.aktiv.vaerdiDkk,
          haeftelserDkk: match.aktiv.haeftelserDkk,
          byggeaar: match.aktiv.byggeaar,
          matchScore: match.bestMatch.score,
        },
      });
      for (const gap of gaps) {
        allGaps.push({
          policyId: match.bestMatch.policy.id,
          checkId: gap.check_id,
          category: gap.category,
          severity: gap.severity,
          title: gap.title,
          description: gap.description,
          recommendation: gap.recommendation,
          estimatedImpactDkk: gap.estimated_impact_dkk,
          sourceData: gap.source_data,
          riskScore: computeRiskScore(gap, {
            type: match.aktiv.type,
            vaerdiDkk: match.aktiv.vaerdiDkk,
            haeftelserDkk: match.aktiv.haeftelserDkk,
            byggeaar: match.aktiv.byggeaar,
          }),
        });
      }
    }

    // 5. Beregn samlet risk-score
    const totalRiskScore =
      allGaps.length > 0
        ? Math.round(allGaps.reduce((sum, g) => sum + g.riskScore, 0) / allGaps.length)
        : 0;

    // 6. Persistér analyse
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);
    const { data: analyse, error: analyseErr } = await db
      .from('forsikring_analyser')
      .insert({
        tenant_id: auth.tenantId,
        kunde_type,
        kunde_id,
        kunde_navn: kunde_navn ?? null,
        total_aktiver: aktiver.length,
        insured_count: insuredCount,
        uninsured_count: aktiver.length - insuredCount,
        total_risk_score: totalRiskScore,
        summary: {
          gaps_count: allGaps.length,
          gaps_critical: allGaps.filter((g) => g.severity === 'critical').length,
          gaps_warning: allGaps.filter((g) => g.severity === 'warning').length,
          policer_count: policer.length,
        },
        created_by: auth.userId,
      })
      .select('id')
      .single();

    if (analyseErr || !analyse) {
      logger.error('[forsikring/analyser] Insert analyse fejl:', analyseErr);
      return NextResponse.json({ error: 'Kunne ikke gemme analyse' }, { status: 500 });
    }

    // 7. Persistér aktiver
    if (aktiver.length > 0) {
      const aktivRows = matches.map((m) => ({
        tenant_id: auth.tenantId,
        analyse_id: analyse.id,
        type: m.aktiv.type,
        label: m.aktiv.label,
        bfe: m.aktiv.bfe ?? null,
        cvr: m.aktiv.cvr ?? null,
        regnr: m.aktiv.regnr ?? null,
        vaerdi_dkk: m.aktiv.vaerdiDkk ?? null,
        haeftelser_dkk: m.aktiv.haeftelserDkk ?? null,
        byggeaar: m.aktiv.byggeaar ?? null,
        ansatte: m.aktiv.ansatte ?? null,
        adresse: m.aktiv.adresse ?? null,
        matched_policy_id: m.bestMatch?.policy.id ?? null,
        match_score: m.bestMatch?.score ?? null,
        raw_data: m.aktiv.rawData ?? null,
      }));

      const { error: aktivErr } = await db.from('forsikring_aktiver').insert(aktivRows);

      if (aktivErr) {
        logger.error('[forsikring/analyser] Insert aktiver fejl:', aktivErr);
      }
    }

    // 8. Persistér gaps
    if (allGaps.length > 0) {
      const gapRows = allGaps.map((g) => ({
        tenant_id: auth.tenantId,
        policy_id: g.policyId,
        check_id: g.checkId,
        category: g.category,
        severity: g.severity,
        title: g.title,
        description: g.description,
        recommendation: g.recommendation,
        estimated_impact_dkk: g.estimatedImpactDkk,
        source_data: g.sourceData,
      }));

      const { error: gapErr } = await db.from('forsikring_gaps').insert(gapRows);

      if (gapErr) {
        logger.error('[forsikring/analyser] Insert gaps fejl:', gapErr);
      }
    }

    logActivity(admin, auth.tenantId, auth.userId, 'page_view', {
      analyse_id: analyse.id,
      kunde_type,
      aktiver: aktiver.length,
      gaps: allGaps.length,
    });

    return NextResponse.json({
      analyse_id: analyse.id,
      total_aktiver: aktiver.length,
      insured_count: insuredCount,
      gaps_count: allGaps.length,
      total_risk_score: totalRiskScore,
    });
  } catch (err) {
    logger.error('[forsikring/analyser] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

/**
 * GET /api/forsikring/analyser — List alle analyser for tenant.
 *
 * @returns { analyser: ForsikringAnalyseRow[] }
 */
export async function GET(): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .schema(schemaName)
      .from('forsikring_analyser')
      .select('*')
      .eq('tenant_id', auth.tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      logger.error('[forsikring/analyser] List fejl:', error);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    return NextResponse.json({ analyser: data ?? [] });
  } catch (err) {
    logger.error('[forsikring/analyser] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
