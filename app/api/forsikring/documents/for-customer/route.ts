/**
 * GET /api/forsikring/documents/for-customer?kunde_id=xxx
 *
 * BIZZ-1404: List alle dokumenter fra tidligere analyser for en kunde.
 * Bruges af NewAnalyseWizard til at vise genbrug-checkboxes.
 *
 * @module api/forsikring/documents/for-customer
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getInsuranceApi } from '@/lib/db/insurance';

/**
 * GET /api/forsikring/documents/for-customer?kunde_id=xxx
 *
 * @returns { documents: Array<{ id, original_name, created_at, from_analyse_id }> }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kundeId = request.nextUrl.searchParams.get('kunde_id');
  if (!kundeId) {
    return NextResponse.json({ error: 'Missing kunde_id' }, { status: 400 });
  }

  try {
    const insurance = await getInsuranceApi(auth.tenantId);
    const docs = await insurance.analyseDocuments.listForCustomer(kundeId);

    return NextResponse.json({
      documents: docs.map((d) => ({
        id: d.id,
        original_name: d.original_name,
        parse_status: d.parse_status,
        created_at: d.created_at,
        from_analyse_id: d.from_analyse_id,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
