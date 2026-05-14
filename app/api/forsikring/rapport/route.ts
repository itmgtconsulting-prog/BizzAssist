/**
 * POST /api/forsikring/rapport — Generer forsikrings gap-rapport som DOCX.
 *
 * BIZZ-1403: Programmatisk rapport med tabeller, farver og KPI-sektioner.
 * Bruger data direkte fra DB — ingen AI-fritekst.
 *
 * Body: { analyse_id: string, kunde_navn: string }
 * Returns: DOCX binary stream
 *
 * @module api/forsikring/rapport
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { getInsuranceApi } from '@/lib/db/insurance';
import { logger } from '@/app/lib/logger';
import { buildGapRapportDocx } from '@/app/lib/forsikring/rapportBuilder';

/**
 * POST /api/forsikring/rapport
 *
 * @param request - { analyse_id, kunde_navn }
 * @returns DOCX binary
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { analyse_id: string; kunde_navn: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { analyse_id, kunde_navn } = body;
  if (!analyse_id) {
    return NextResponse.json({ error: 'Missing analyse_id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Hent analyse + aktiver + gaps parallelt
    const [analyseRes, aktiverRes] = await Promise.all([
      db
        .from('forsikring_analyser')
        .select('*')
        .eq('id', analyse_id)
        .eq('tenant_id', auth.tenantId)
        .maybeSingle(),
      db
        .from('forsikring_aktiver')
        .select('*')
        .eq('analyse_id', analyse_id)
        .eq('tenant_id', auth.tenantId)
        .order('type'),
    ]);

    if (!analyseRes.data) {
      return NextResponse.json({ error: 'Analyse ikke fundet' }, { status: 404 });
    }

    // Hent policer
    const insurance = await getInsuranceApi(auth.tenantId);
    const policies = await insurance.policies.list();

    // Hent gaps for matchede policer
    const matchedPolicyIds = [
      ...new Set(
        (aktiverRes.data ?? [])
          .map((a: { matched_policy_id: string | null }) => a.matched_policy_id)
          .filter(Boolean) as string[]
      ),
    ];

    let gaps: Array<{
      id: string;
      policy_id: string;
      severity: string;
      title: string;
      description: string;
      recommendation: string | null;
      check_id: string;
    }> = [];
    if (matchedPolicyIds.length > 0) {
      const { data } = await db
        .from('forsikring_gaps')
        .select('*')
        .in('policy_id', matchedPolicyIds)
        .eq('tenant_id', auth.tenantId)
        .order('severity');
      gaps = data ?? [];
    }

    // Build DOCX
    const docxBuffer = await buildGapRapportDocx({
      kundeNavn: kunde_navn || 'Ukendt kunde',
      analyse: analyseRes.data as {
        total_aktiver: number;
        insured_count: number;
        uninsured_count: number;
        total_risk_score: number;
        created_at: string;
      },
      aktiver: (aktiverRes.data ?? []) as Array<{
        type: string;
        label: string;
        adresse: string | null;
        matched_policy_id: string | null;
        match_score: number | null;
      }>,
      policies: policies.map((p) => ({
        id: p.id,
        policy_number: p.policy_number,
        insurer_name: p.insurer_name,
        property_address: p.property_address,
        annual_premium_dkk: p.annual_premium_dkk,
        effective_to: p.effective_to,
        sum_insured_dkk: p.sum_insured_dkk,
      })),
      gaps: gaps.map((g) => ({
        policy_id: g.policy_id,
        severity: g.severity,
        title: g.title,
        description: g.description,
        recommendation: g.recommendation,
      })),
    });

    logger.log(`[forsikring/rapport] Genereret rapport for ${kunde_navn}: ${docxBuffer.length}B`);

    return new NextResponse(new Uint8Array(docxBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="Forsikrings-Gap-Rapport-${encodeURIComponent(kunde_navn)}.docx"`,
      },
    });
  } catch (err) {
    logger.error('[forsikring/rapport]', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
