/**
 * GET /api/forsikring/documents/for-customer?kunde_id=xxx
 *
 * BIZZ-1404: List alle tilgængelige dokumenter for genbrug i ny analyse.
 * Viser docs fra junction-tabel (analyse-linkede) + ulinket parsed docs.
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

    // Prøv junction-tabel først (analyse-linkede docs)
    const linkedDocs = await insurance.analyseDocuments.listForCustomer(kundeId);

    if (linkedDocs.length > 0) {
      return NextResponse.json({
        documents: linkedDocs.map((d) => ({
          id: d.id,
          original_name: d.original_name,
          parse_status: d.parse_status,
          created_at: d.created_at,
          from_analyse_id: d.from_analyse_id,
        })),
      });
    }

    // Fallback: vis ALLE parsed docs for tenant (pre-BIZZ-1404 data)
    const allDocs = await insurance.documents.list();
    const parsedDocs = allDocs.filter((d) => d.parse_status === 'parsed');

    return NextResponse.json({
      documents: parsedDocs.map((d) => ({
        id: d.id,
        original_name: d.original_name,
        parse_status: d.parse_status,
        created_at: d.created_at,
        from_analyse_id: null,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
