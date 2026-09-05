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
import { createAdminClient } from '@/lib/supabase/admin';
import { getDomainLinkedTenants } from '@/app/lib/domainFederation';

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
    const admin = createAdminClient();

    // BIZZ-2192.3b: Domæne-federation (ADR-0011). Kunde-dokumenter læses fra egen
    // tenant ∪ co-domæne-medlemmers tenants (getDomainLinkedTenants, query-tid).
    // Vi kan IKKE bruge getInsuranceApi her — den kalder verifyTenantAccess pr.
    // tenant, hvilket blokerer co-medlemmers schemaer. Federationen ER
    // adgangsmodellen, så vi læser direkte pr. federations-schema (kun dem
    // helperen returnerer → ingen læk). uploaded_by-filteret droppes bevidst:
    // domæne-medlemskab deler co-medlemmers kunde-docs.
    const seenIds = new Set<string>();
    const allDocs: Array<{
      id: string;
      original_name: string;
      parse_status: string;
      created_at: string;
      // BIZZ-2156: parse-tidspunkt (updated_at bumpes når parse afsluttes)
      updated_at: string;
      from_analyse_id?: string;
    }> = [];

    const schemas = await getDomainLinkedTenants(auth.userId);
    for (const schema of schemas) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = (admin as any).schema(schema);

        // 1. Junction-tabel (analyse-linkede docs) for denne kunde i dette schema
        const { data: analyser } = await db
          .from('forsikring_analyser')
          .select('id')
          .eq('kunde_id', kundeId);
        const analyseIds = (analyser ?? []).map((a: { id: string }) => a.id);
        const linkMap = new Map<string, string>();
        let junctionDocIds: string[] = [];
        if (analyseIds.length > 0) {
          const { data: links } = await db
            .from('forsikring_analyse_documents')
            .select('analyse_id, document_id')
            .in('analyse_id', analyseIds);
          for (const l of (links ?? []) as Array<{ analyse_id: string; document_id: string }>) {
            if (!linkMap.has(l.document_id)) linkMap.set(l.document_id, l.analyse_id);
          }
          junctionDocIds = [...linkMap.keys()];
        }
        if (junctionDocIds.length > 0) {
          const { data: jdocs } = await db
            .from('forsikring_documents')
            .select('id, original_name, parse_status, created_at, updated_at')
            .in('id', junctionDocIds);
          for (const d of (jdocs ?? []) as Array<Record<string, unknown>>) {
            const id = d.id as string;
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            allDocs.push({
              id,
              original_name: d.original_name as string,
              parse_status: d.parse_status as string,
              created_at: d.created_at as string,
              updated_at: d.updated_at as string,
              from_analyse_id: linkMap.get(id) ?? '',
            });
          }
        }

        // 2. Direkte docs (uanalyserede uploads) for kunden i dette schema
        const { data: directDocs } = await db
          .from('forsikring_documents')
          .select('id, original_name, parse_status, created_at, updated_at')
          .eq('kunde_id', kundeId)
          .order('created_at', { ascending: false })
          .limit(50);
        for (const d of (directDocs ?? []) as Array<Record<string, unknown>>) {
          const id = d.id as string;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          allDocs.push({
            id,
            original_name: d.original_name as string,
            parse_status: d.parse_status as string,
            created_at: d.created_at as string,
            updated_at: d.updated_at as string,
          });
        }
      } catch {
        // schema ikke PostgREST-eksponeret / mangler tabel → spring sikkert over
      }
    }

    // Nyeste først
    allDocs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json({ documents: allDocs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
