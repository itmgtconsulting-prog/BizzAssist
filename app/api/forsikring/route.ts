/**
 * GET /api/forsikring
 *
 * Returnér alle forsikrings-policer + dokument-status for tenant.
 * Bruges af /dashboard/forsikring liste-side til at vise både parsed
 * policer OG endnu-ikke-parsed dokumenter (med parse_status badge).
 *
 * @returns { policies, documents, totals: { policies, gaps_critical, gaps_warning } }
 *
 * @module api/forsikring
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';
import { getInsuranceApi } from '@/lib/db/insurance';
import type { ForsikringGap } from '@/app/lib/forsikring/types';

/**
 * GET /api/forsikring?sag_id=xxx
 *
 * BIZZ-1399: Optionelt sag_id filter — returnerer kun policer/dokumenter
 * tilknyttet den pågældende sag. Uden sag_id returneres alt (backward compat).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // BIZZ-1399: Optionelt sag_id filter
  const sagId = request.nextUrl.searchParams.get('sag_id') || null;

  try {
    const insurance = await getInsuranceApi(auth.tenantId);
    let [policies, documents] = await Promise.all([
      insurance.policies.list(),
      insurance.documents.list(),
    ]);

    // BIZZ-1399: Filtrér per sag hvis sag_id er angivet
    if (sagId) {
      policies = policies.filter((p) => (p as unknown as Record<string, unknown>).sag_id === sagId);
      documents = documents.filter(
        (d) => (d as unknown as Record<string, unknown>).sag_id === sagId
      );
    }

    // Hent gap-tællinger for alle policer (parallelt) for KPI-badges
    const gapsByPolicy = await Promise.all(policies.map((p) => insurance.gaps.listForPolicy(p.id)));
    const gapMap = new Map<string, ForsikringGap[]>();
    policies.forEach((p, i) => {
      gapMap.set(p.id, gapsByPolicy[i]);
    });

    let critical = 0;
    let warning = 0;
    let info = 0;
    for (const gaps of gapsByPolicy) {
      for (const g of gaps) {
        if (g.severity === 'critical') critical++;
        else if (g.severity === 'warning') warning++;
        else info++;
      }
    }

    return NextResponse.json({
      policies: policies.map((p) => ({
        id: p.id,
        policy_number: p.policy_number,
        insurer_name: p.insurer_name,
        policyholder_name: p.policyholder_name,
        property_address: p.property_address,
        annual_premium_dkk: p.annual_premium_dkk,
        effective_to: p.effective_to,
        main_renewal_date: p.main_renewal_date,
        gap_counts: {
          critical: gapMap.get(p.id)?.filter((g) => g.severity === 'critical').length ?? 0,
          warning: gapMap.get(p.id)?.filter((g) => g.severity === 'warning').length ?? 0,
          info: gapMap.get(p.id)?.filter((g) => g.severity === 'info').length ?? 0,
        },
        created_at: p.created_at,
      })),
      documents: documents
        .filter((d) => d.parse_status !== 'parsed' || d.policy_id === null)
        .map((d) => ({
          id: d.id,
          original_name: d.original_name,
          parse_status: d.parse_status,
          parse_error: d.parse_error,
          created_at: d.created_at,
        })),
      totals: {
        policies: policies.length,
        gaps_critical: critical,
        gaps_warning: warning,
        gaps_info: info,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ukendt fejl';
    logger.error('[forsikring GET]', message);
    // BIZZ-1380: Returnér fejltype så UI kan skelne auth-fejl fra data-fejl
    if (
      message.includes('membership') ||
      message.includes('access') ||
      message.includes('Unauthorized')
    ) {
      return NextResponse.json({ error: 'Ikke adgang til forsikringsmodulet' }, { status: 403 });
    }
    return NextResponse.json(
      { error: 'Serverfejl', detail: message.slice(0, 200) },
      { status: 500 }
    );
  }
}
