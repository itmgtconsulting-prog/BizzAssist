/**
 * GET /api/forsikring/analyser/[id]/eksport?format=docx
 *
 * BIZZ-1376: Generér mæglerrapport som DOCX for en gap-analyse.
 * Indeholder: header, kunde-info, aktiv-oversigt, gap-liste med
 * risk-scoring og anbefalinger.
 *
 * @module api/forsikring/analyser/[id]/eksport
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';
import { riskLabel } from '@/app/lib/forsikring/gapEngine';
import { buildGapRapportDocx } from '@/app/lib/forsikring/rapportBuilder';

export const maxDuration = 30;

/**
 * GET /api/forsikring/analyser/[id]/eksport
 *
 * @param request - Next.js request med ?format=docx|csv
 * @param params - Route params med analyse-ID
 * @returns DOCX eller CSV fil
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
  const format = request.nextUrl.searchParams.get('format') ?? 'csv';

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    const [analyseResult, aktiverResult, gapsResult, policiesResult, coveragesResult] =
      await Promise.all([
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
          .order('type'),
        db.from('forsikring_gaps').select('*').eq('tenant_id', auth.tenantId),
        db.from('forsikring_policies').select('*').eq('tenant_id', auth.tenantId),
        // BIZZ-1633: Hent dækninger for rapport
        db.from('forsikring_coverages').select('*').eq('tenant_id', auth.tenantId),
      ]);

    if (!analyseResult.data) {
      return NextResponse.json({ error: 'Analyse ikke fundet' }, { status: 404 });
    }

    const analyse = analyseResult.data;
    const aktiver = aktiverResult.data ?? [];
    const gaps = gapsResult.data ?? [];
    const policies = policiesResult.data ?? [];
    const coverages = coveragesResult.data ?? [];

    if (format === 'csv') {
      return generateCsv(analyse, aktiver, gaps);
    }

    // BIZZ-1618: Generér styled DOCX med farvede severity-cards, metrics-bar,
    // ejendomsliste og police-oversigt — matcher dashboard-layoutet.
    if (format === 'docx') {
      const buf = await buildGapRapportDocx({
        kundeNavn: (analyse.kunde_navn as string) ?? String(analyse.kunde_id),
        analyse: {
          total_aktiver: analyse.total_aktiver as number,
          insured_count: analyse.insured_count as number,
          uninsured_count: analyse.uninsured_count as number,
          total_risk_score: analyse.total_risk_score as number,
          created_at: analyse.created_at as string,
        },
        aktiver: aktiver.map((a: Record<string, unknown>) => ({
          type: String(a.type ?? ''),
          label: String(a.label ?? ''),
          adresse: (a.adresse as string) ?? null,
          matched_policy_id: (a.matched_policy_id as string) ?? null,
          match_score: (a.match_score as number) ?? null,
        })),
        policies: policies.map((p: Record<string, unknown>) => ({
          id: String(p.id ?? ''),
          policy_number: String(p.policy_number ?? ''),
          insurer_name: String(p.insurer_name ?? ''),
          property_address: (p.property_address as string) ?? null,
          annual_premium_dkk: (p.annual_premium_dkk as number) ?? null,
          effective_to: (p.effective_to as string) ?? null,
          sum_insured_dkk: (p.sum_insured_dkk as number) ?? null,
        })),
        gaps: gaps.map((g: Record<string, unknown>) => ({
          policy_id: String(g.policy_id ?? ''),
          severity: String(g.severity ?? 'info'),
          title: String(g.title ?? ''),
          description: String(g.description ?? ''),
          recommendation: (g.recommendation as string) ?? null,
        })),
        // BIZZ-1633: Dækninger per police
        coverages: coverages.map((c: Record<string, unknown>) => ({
          policy_id: String(c.policy_id ?? ''),
          coverage_code: String(c.coverage_code ?? ''),
          coverage_label: String(c.label ?? c.coverage_code ?? ''),
          is_covered: c.is_covered !== false,
          sum_insured_dkk: (c.sum_insured_dkk as number) ?? null,
          deductible_dkk: (c.deductible_dkk as number) ?? null,
        })),
        // BIZZ-1973: Adresse-mismatch advarsel fra analysens summary
        addressMismatches: Array.isArray(
          (analyse.summary as Record<string, unknown> | null)?.address_mismatches
        )
          ? (
              (analyse.summary as Record<string, unknown>).address_mismatches as Array<
                Record<string, unknown>
              >
            ).map((m) => ({
              policy_number: String(m.policy_number ?? ''),
              insurer_name: String(m.insurer_name ?? ''),
              property_address: (m.property_address as string) ?? null,
              is_policyholder_address: m.is_policyholder_address === true,
            }))
          : [],
      });

      const kundeSlug = ((analyse.kunde_navn as string) ?? String(analyse.kunde_id))
        .replace(/[^a-zA-Z0-9æøåÆØÅ ]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase()
        .slice(0, 40);

      return new NextResponse(new Uint8Array(buf), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="gap-rapport-${kundeSlug}.docx"`,
        },
      });
    }

    // Fallback: JSON
    return NextResponse.json({
      rapport: {
        title: `Forsikrings-gap-analyse: ${analyse.kunde_navn ?? analyse.kunde_id}`,
        dato: new Date(analyse.created_at).toLocaleDateString('da-DK'),
        kunde: {
          type: analyse.kunde_type,
          id: analyse.kunde_id,
          navn: analyse.kunde_navn,
        },
        sammenfatning: {
          total_aktiver: analyse.total_aktiver,
          forsikrede: analyse.insured_count,
          uforsikrede: analyse.uninsured_count,
          risk_score: analyse.total_risk_score,
          risk_label: riskLabel(analyse.total_risk_score),
        },
        aktiver: aktiver.map((a: Record<string, unknown>) => ({
          type: a.type,
          label: a.label,
          adresse: a.adresse,
          matched: a.matched_policy_id != null,
          match_score: a.match_score,
        })),
        gaps: gaps.map((g: Record<string, unknown>) => ({
          severity: g.severity,
          title: g.title,
          description: g.description,
          recommendation: g.recommendation,
        })),
      },
    });
  } catch (err) {
    logger.error('[forsikring/analyser/eksport] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

/**
 * Generér CSV-eksport af analyse-resultat.
 *
 * @param analyse - Analyse-row
 * @param aktiver - Aktiver-rows
 * @param gaps - Gap-rows
 * @returns CSV response
 */
function generateCsv(
  analyse: Record<string, unknown>,
  aktiver: Array<Record<string, unknown>>,
  gaps: Array<Record<string, unknown>>
): NextResponse {
  const lines: string[] = [];

  // Header
  lines.push('Forsikrings-gap-analyse');
  lines.push(`Kunde;${analyse.kunde_navn ?? analyse.kunde_id}`);
  lines.push(`Dato;${new Date(analyse.created_at as string).toLocaleDateString('da-DK')}`);
  lines.push(`Aktiver;${analyse.total_aktiver}`);
  lines.push(`Forsikrede;${analyse.insured_count}`);
  lines.push(`Risk score;${analyse.total_risk_score}`);
  lines.push('');

  // Aktiver
  lines.push('AKTIVER');
  lines.push('Type;Label;Adresse;Matched;Score');
  for (const a of aktiver) {
    lines.push(
      [
        a.type,
        a.label,
        a.adresse ?? '',
        a.matched_policy_id ? 'Ja' : 'Nej',
        a.match_score ?? '',
      ].join(';')
    );
  }
  lines.push('');

  // Gaps
  lines.push('GAPS');
  lines.push('Severity;Titel;Beskrivelse;Anbefaling');
  for (const g of gaps) {
    lines.push(
      [
        g.severity,
        String(g.title ?? '').replace(/;/g, ','),
        String(g.description ?? '')
          .replace(/;/g, ',')
          .replace(/\n/g, ' '),
        String(g.recommendation ?? '').replace(/;/g, ','),
      ].join(';')
    );
  }

  const csv = lines.join('\n');
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="gap-analyse-${analyse.kunde_id}.csv"`,
    },
  });
}
