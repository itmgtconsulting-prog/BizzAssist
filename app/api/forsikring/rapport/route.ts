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

    // BIZZ-1404: Hent policer scoped til analyse via junction-tabel
    const { data: docLinks } = await db
      .from('forsikring_analyse_documents')
      .select('document_id')
      .eq('analyse_id', analyse_id)
      .eq('tenant_id', auth.tenantId);
    const docIds = (docLinks ?? []).map((l: { document_id: string }) => l.document_id);

    let policies: Array<{
      id: string;
      policy_number: string;
      insurer_name: string;
      property_address: string | null;
      annual_premium_dkk: number | null;
      effective_to: string | null;
      sum_insured_dkk: number | null;
      building_use?: string | null;
      building_area_m2?: number | null;
      building_floors?: number | null;
      building_year_built?: number | null;
      building_has_basement?: boolean | null;
      insurance_form?: string | null;
      business_activity?: string | null;
    }> = [];

    if (docIds.length > 0) {
      // BIZZ-2169: select('*') så bygnings-felter (building_use/_area_m2/_floors/
      // _year_built) kommer med til BBR-vs-police-sammenligningen i rapporten.
      const { data: polRows } = await db
        .from('forsikring_policies')
        .select('*')
        .in('document_id', docIds)
        .eq('tenant_id', auth.tenantId);
      policies = polRows ?? [];
    } else {
      // Fallback: alle policer (legacy analyser uden junction-links)
      const insurance = await getInsuranceApi(auth.tenantId);
      const allPolicies = await insurance.policies.list();
      policies = allPolicies.map((p) => ({
        id: p.id,
        policy_number: p.policy_number,
        insurer_name: p.insurer_name,
        property_address: p.property_address,
        annual_premium_dkk: p.annual_premium_dkk,
        effective_to: p.effective_to,
        sum_insured_dkk: p.sum_insured_dkk,
      }));
    }

    // Hent gaps — prefer analyse-scoped
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
    // Prøv analyse-scoped gaps først, fallback til legacy policy-scoped
    const { data: scopedGaps } = await db
      .from('forsikring_gaps')
      .select('*')
      .eq('analyse_id', analyse_id)
      .eq('tenant_id', auth.tenantId)
      .order('severity');

    if (scopedGaps && scopedGaps.length > 0) {
      gaps = scopedGaps;
    } else if (matchedPolicyIds.length > 0) {
      const { data } = await db
        .from('forsikring_gaps')
        .select('*')
        .in('policy_id', matchedPolicyIds)
        .eq('tenant_id', auth.tenantId)
        .order('severity');
      gaps = data ?? [];
    }

    // BIZZ-2169: Berig med samme data som detalje-skærmen (coverages,
    // refererede standardbetingelser, BBR-bygningsdata) så rapporten
    // afspejler det fulde analyse-billede brugeren ser på skærmen.
    const analysePolicyIds = policies.map((p) => p.id);
    const coveragePolicyIds = [...new Set([...matchedPolicyIds, ...analysePolicyIds])];
    let coverages: Array<{
      policy_id: string;
      coverage_code: string;
      coverage_label: string;
      is_covered: boolean;
      sum_dkk: number | null;
      deductible_dkk: number | null;
      conditions_ref?: string | null;
    }> = [];
    if (coveragePolicyIds.length > 0) {
      const { data: coverageRows } = await db
        .from('forsikring_coverages')
        .select(
          'policy_id, coverage_code, coverage_label, is_covered, sum_dkk, deductible_dkk, conditions_ref'
        )
        .in('policy_id', coveragePolicyIds)
        .eq('tenant_id', auth.tenantId)
        .order('coverage_label', { ascending: true });
      coverages = coverageRows ?? [];
    }

    // BIZZ-2135: Aggregér refererede standardbetingelser fra coverages
    const conditionsMap = new Map<
      string,
      { ref: string; selskab: string | null; policyNumber: string | null }
    >();
    for (const cov of coverages) {
      if (!cov.conditions_ref) continue;
      for (let rawRef of cov.conditions_ref
        .split(/[,;]/)
        .map((s: string) => s.trim())
        .filter(Boolean)) {
        rawRef = rawRef.replace(/^(se\s+)?(betingelses)?afsnit\s*/i, '').trim();
        if (!rawRef || /^se\s+vilk/i.test(rawRef) || rawRef.length < 2) continue;
        if (!conditionsMap.has(rawRef)) {
          const pol = policies.find((p) => p.id === cov.policy_id);
          conditionsMap.set(rawRef, {
            ref: rawRef,
            selskab: pol?.insurer_name ?? null,
            policyNumber: pol?.policy_number ?? null,
          });
        }
      }
    }
    const uploadedRefs = new Set<string>();
    if (conditionsMap.size > 0) {
      try {
        const { data: stdDocs } = await admin
          .from('forsikring_standard_doc')
          .select('titel')
          .limit(200);
        if (stdDocs) {
          for (const doc of stdDocs as Array<{ titel: string }>) {
            const titelLower = doc.titel.toLowerCase();
            for (const ref of conditionsMap.keys()) {
              if (titelLower.includes(ref.toLowerCase())) uploadedRefs.add(ref);
            }
          }
        }
      } catch {
        // Non-fatal — standard-docs check
      }
    }
    const referencedConditions = [...conditionsMap.values()].map((c) => ({
      ...c,
      uploaded: uploadedRefs.has(c.ref),
    }));

    // BIZZ-2155: BBR-bygningsdata pr. BFE til BBR-vs-police-sammenligning
    const bbrByBfe: Record<
      string,
      {
        bebygget_areal: number | null;
        antal_etager: number | null;
        opfoerelsesaar: number | null;
        anvendelse: string | null;
      }
    > = {};
    const ejendomBfer = [
      ...new Set(
        (aktiverRes.data ?? [])
          .filter((a: { type: string; bfe: number | null }) => a.type === 'ejendom' && a.bfe)
          .map((a: { bfe: number | null }) => a.bfe as number)
      ),
    ];
    if (ejendomBfer.length > 0) {
      const { data: bbrRows } = await admin
        .from('bbr_ejendom_status')
        .select('bfe_nummer, bebygget_areal, antal_etager, opfoerelsesaar, byg021_anvendelse')
        .in('bfe_nummer', ejendomBfer);
      for (const row of (bbrRows ?? []) as Array<{
        bfe_nummer: number;
        bebygget_areal: number | null;
        antal_etager: number | null;
        opfoerelsesaar: number | null;
        byg021_anvendelse: string | null;
      }>) {
        bbrByBfe[String(row.bfe_nummer)] = {
          bebygget_areal: row.bebygget_areal,
          antal_etager: row.antal_etager,
          opfoerelsesaar: row.opfoerelsesaar,
          anvendelse: row.byg021_anvendelse,
        };
      }
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
        bfe?: number | null;
        cvr?: string | null;
        matched_policy_id: string | null;
        match_score: number | null;
        raw_data?: {
          ejer_cvr?: string;
          ejerandel_pct?: number | string | null;
          minoritet?: boolean;
          administreret?: boolean;
          daekket_via_sfe?: { sfe_adresse?: string } | null;
          soester_sfe?: { sfe_adresse?: string } | null;
        } | null;
      }>,
      policies: policies.map((p) => ({
        id: p.id,
        policy_number: p.policy_number,
        insurer_name: p.insurer_name,
        property_address: p.property_address,
        annual_premium_dkk: p.annual_premium_dkk,
        effective_to: p.effective_to,
        sum_insured_dkk: p.sum_insured_dkk,
        building_use: p.building_use ?? null,
        building_area_m2: p.building_area_m2 ?? null,
        building_floors: p.building_floors ?? null,
        building_year_built: p.building_year_built ?? null,
        building_has_basement: p.building_has_basement ?? null,
        insurance_form: p.insurance_form ?? null,
        business_activity: p.business_activity ?? null,
      })),
      gaps: gaps.map((g) => ({
        policy_id: g.policy_id,
        severity: g.severity,
        title: g.title,
        description: g.description,
        recommendation: g.recommendation,
        check_id: g.check_id,
      })),
      coverages,
      referencedConditions,
      bbrByBfe,
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
