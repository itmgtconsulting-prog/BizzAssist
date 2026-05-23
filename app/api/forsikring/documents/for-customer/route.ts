/**
 * GET /api/forsikring/documents/for-customer?kunde_id=xxx
 *
 * BIZZ-1404 + BIZZ-1791: List dokumenter for en forsikringsejer.
 *
 * Strategi:
 *   1. Junction-tabel (analyse-linkede docs) — viser docs fra tidligere analyser
 *   2. Direkte opslag i forsikring_documents filtreret på kunde_id + uploaded_by
 *      → viser brugerens egne docs for denne kunde, uanset om de er analyserede
 *
 * Scoping: Kun den aktuelle brugers docs vises. Andre brugere i tenant
 * kan IKKE se hinandens docs (undtagen via domain — fremtidig feature).
 *
 * @module api/forsikring/documents/for-customer
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getInsuranceApi } from '@/lib/db/insurance';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';

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

    // 1. Junction-tabel (analyse-linkede docs) — filtrér på brugerens analyser
    const linkedDocs = await insurance.analyseDocuments.listForCustomer(kundeId);

    // 2. BIZZ-1791: Direkte opslag i forsikring_documents — brugerens egne docs
    // for denne kunde, inkl. docs der ikke er koblet til en analyse endnu
    const schemaName = await getTenantSchemaName(auth.tenantId);
    let directDocs: Array<Record<string, unknown>> = [];
    if (schemaName) {
      const admin = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .schema(schemaName)
        .from('forsikring_documents')
        .select('id, original_name, parse_status, created_at')
        .eq('kunde_id', kundeId)
        .eq('uploaded_by', auth.userId)
        .order('created_at', { ascending: false })
        .limit(50);
      directDocs = (data ?? []) as Array<Record<string, unknown>>;
    }

    // Merge + dedup (junction docs kan overlappe med direkte docs)
    const seenIds = new Set<string>();
    const allDocs: Array<{
      id: string;
      original_name: string;
      parse_status: string;
      created_at: string;
      from_analyse_id?: string;
    }> = [];

    // Junction docs først (har from_analyse_id)
    for (const d of linkedDocs) {
      if (seenIds.has(d.id)) continue;
      seenIds.add(d.id);
      allDocs.push({
        id: d.id,
        original_name: d.original_name,
        parse_status: d.parse_status,
        created_at: d.created_at,
        from_analyse_id: d.from_analyse_id,
      });
    }

    // Direkte docs (brugerens egne, evt. uanalyserede)
    for (const d of directDocs) {
      const id = d.id as string;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      allDocs.push({
        id,
        original_name: d.original_name as string,
        parse_status: d.parse_status as string,
        created_at: d.created_at as string,
      });
    }

    return NextResponse.json({ documents: allDocs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
