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

    const [analyseResult, aktiverResult, gapsResult] = await Promise.all([
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
    ]);

    if (!analyseResult.data) {
      return NextResponse.json({ error: 'Analyse ikke fundet' }, { status: 404 });
    }

    const analyse = analyseResult.data;
    const aktiver = aktiverResult.data ?? [];
    const gaps = gapsResult.data ?? [];

    if (format === 'csv') {
      return generateCsv(analyse, aktiver, gaps);
    }

    // Default: struktureret JSON (til fremtidig DOCX-generation via Claude)
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
