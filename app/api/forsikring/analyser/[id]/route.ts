/**
 * GET /api/forsikring/analyser/[id] — Hent analyse-detaljer med aktiver + gaps + dokumenter + policer.
 *
 * BIZZ-1366: Returnerer fuld analyse med aktiver og gaps for UI-rendering.
 * BIZZ-1404: Tilføjer scoped dokumenter og policer via junction-tabel.
 *
 * @module api/forsikring/analyser/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

/**
 * GET /api/forsikring/analyser/[id]
 *
 * @param request - Next.js request
 * @param params - Route params med analyse-ID
 * @returns Analyse + aktiver + gaps + documents + policies
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
  if (!id) {
    return NextResponse.json({ error: 'Missing analyse id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Parallelt: hent analyse + aktiver + analyse-dokumenter
    const [analyseResult, aktiverResult, docLinksResult] = await Promise.all([
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
        .order('type', { ascending: true }),
      db
        .from('forsikring_analyse_documents')
        .select('document_id, source')
        .eq('analyse_id', id)
        .eq('tenant_id', auth.tenantId),
    ]);

    if (analyseResult.error || !analyseResult.data) {
      return NextResponse.json({ error: 'Analyse ikke fundet' }, { status: 404 });
    }

    // BIZZ-1404: Hent scoped dokumenter via junction-tabel
    const docLinks = (docLinksResult.data ?? []) as Array<{ document_id: string; source: string }>;
    const docIds = docLinks.map((l) => l.document_id);
    const sourceMap = new Map(docLinks.map((l) => [l.document_id, l.source]));

    let documents: unknown[] = [];
    let policies: unknown[] = [];

    if (docIds.length > 0) {
      // Hent dokumenter + policer der hører til disse dokumenter
      const [docsResult, policiesResult] = await Promise.all([
        db
          .from('forsikring_documents')
          .select('id, original_name, parse_status, parse_error, created_at')
          .in('id', docIds)
          .eq('tenant_id', auth.tenantId),
        db
          .from('forsikring_policies')
          .select('*')
          .in('document_id', docIds)
          .eq('tenant_id', auth.tenantId)
          .order('created_at', { ascending: false }),
      ]);

      documents = (docsResult.data ?? []).map((d: Record<string, unknown>) => ({
        ...d,
        source: sourceMap.get(d.id as string) ?? 'uploaded',
      }));
      policies = policiesResult.data ?? [];
    }

    // Hent gaps — prefer analyse_id scoped, fallback til policy_id for legacy
    const matchedPolicyIds = (aktiverResult.data ?? [])
      .map((a: { matched_policy_id: string | null }) => a.matched_policy_id)
      .filter(Boolean) as string[];

    // BIZZ-2119: Matchede policer kan ligge uden for analysens dokument-scope
    // (fx legacy-analyser uden junction-rækker eller delte koncern-policer).
    // Hent de manglende police-rækker eksplicit, så UI'et altid kan vise
    // selskab + policenummer for hvert match i stedet for en fallback-tekst.
    const knownPolicyIds = new Set((policies as Array<{ id: string }>).map((p) => p.id));
    const missingPolicyIds = [...new Set(matchedPolicyIds)].filter(
      (pid) => !knownPolicyIds.has(pid)
    );
    if (missingPolicyIds.length > 0) {
      const { data: extraPolicies } = await db
        .from('forsikring_policies')
        .select('*')
        .in('id', missingPolicyIds)
        .eq('tenant_id', auth.tenantId);
      if (extraPolicies && extraPolicies.length > 0) {
        policies = [...policies, ...extraPolicies];
        // Hent også kildedokument-navne for de ekstra policer, så UI'et kan
        // vise hvilket dokument matchet stammer fra.
        const extraDocIds = [
          ...new Set(
            (extraPolicies as Array<{ document_id: string | null }>)
              .map((p) => p.document_id)
              .filter((d): d is string => Boolean(d) && !docIds.includes(d as string))
          ),
        ];
        if (extraDocIds.length > 0) {
          const { data: extraDocs } = await db
            .from('forsikring_documents')
            .select('id, original_name, parse_status, parse_error, created_at')
            .in('id', extraDocIds)
            .eq('tenant_id', auth.tenantId);
          documents = [
            ...documents,
            ...(extraDocs ?? []).map((d: Record<string, unknown>) => ({
              ...d,
              source: 'matched',
            })),
          ];
        }
      }
    }

    // BIZZ-2129: Tilhørs-data til (a) at surface adresseløse koncern-policer og
    // (c) klassificere hver polices tilknytning. Bygges fra de persisterede
    // aktiver + analysens kunde-felter.
    const analyseRow = analyseResult.data as {
      kunde_type?: string;
      kunde_id?: string;
      kunde_navn?: string;
    };
    const aktiverData = (aktiverResult.data ?? []) as Array<{
      type: string;
      cvr: string | null;
      adresse: string | null;
      label: string;
    }>;
    const koncernCvrSet = new Set(
      aktiverData.filter((a) => a.type === 'virksomhed' && a.cvr).map((a) => a.cvr as string)
    );
    if (analyseRow.kunde_type === 'virksomhed' && analyseRow.kunde_id) {
      koncernCvrSet.add(analyseRow.kunde_id);
    }
    const koncernNavne = aktiverData
      .filter((a) => a.type === 'virksomhed')
      .map((a) => a.label.toLowerCase().trim())
      .filter((n) => n.length > 0);
    if (analyseRow.kunde_navn) koncernNavne.push(analyseRow.kunde_navn.toLowerCase().trim());
    const normAdr = (s: string | null) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const aktivAdrNorm = aktiverData
      .filter((a) => a.type === 'ejendom' && a.adresse)
      .map((a) => normAdr(a.adresse));
    const adrMatcher = (addr: string | null) => {
      const a = normAdr(addr);
      if (!a) return false;
      return aktivAdrNorm.some((x) => x === a || x.startsWith(a) || a.startsWith(x));
    };

    // (a) Når analysen mangler dokument-links (koncern-fallback) inkluderes
    // kundens øvrige policer — også adresseløse (Ansvar, Cyber, Netbank,
    // Kriminalitet) — efter samme tilhørs-logik som analysens fallback
    // (BIZZ-2120). Ved eksplicit dokument-scope (junction populeret) holdes
    // listen til scope'et.
    if (docIds.length === 0) {
      const haveIds = new Set((policies as Array<{ id: string }>).map((p) => p.id));
      const { data: allTenantPolicies } = await db
        .from('forsikring_policies')
        .select('*')
        .eq('tenant_id', auth.tenantId);
      const hoererTilKoncern = (p: {
        policyholder_cvr: string | null;
        policyholder_name: string | null;
        property_address: string | null;
      }) => {
        if (p.policyholder_cvr && koncernCvrSet.has(p.policyholder_cvr)) return true;
        const pn = (p.policyholder_name ?? '').toLowerCase().trim();
        if (pn && koncernNavne.some((n) => pn === n || pn.includes(n) || n.includes(pn)))
          return true;
        return adrMatcher(p.property_address);
      };
      for (const p of (allTenantPolicies ?? []) as Array<Record<string, unknown>>) {
        if (haveIds.has(p.id as string)) continue;
        if (
          hoererTilKoncern(
            p as {
              policyholder_cvr: string | null;
              policyholder_name: string | null;
              property_address: string | null;
            }
          )
        ) {
          policies = [...policies, p];
          haveIds.add(p.id as string);
        }
      }
    }

    // (c) Klassificér hver polices tilknytning: 'sikker' når den er bekræftet
    // via forsikringstager-CVR, forsikringssted-match eller aktiv-match;
    // ellers 'tvivlsom' (kun inkluderet via fuzzy navne-match) → UI viser gul
    // advarsel.
    const matchedSet = new Set(matchedPolicyIds);
    policies = (policies as Array<Record<string, unknown>>).map((p) => {
      const cvrOk = !!p.policyholder_cvr && koncernCvrSet.has(p.policyholder_cvr as string);
      const adrOk = adrMatcher(p.property_address as string | null);
      const aktivOk = matchedSet.has(p.id as string);
      return { ...p, attachment: cvrOk || adrOk || aktivOk ? 'sikker' : 'tvivlsom' };
    });

    let gaps: unknown[] = [];

    // Først: prøv analyse-scoped gaps
    const { data: scopedGaps } = await db
      .from('forsikring_gaps')
      .select('*')
      .eq('analyse_id', id)
      .eq('tenant_id', auth.tenantId)
      .order('severity', { ascending: true });

    if (scopedGaps && scopedGaps.length > 0) {
      gaps = scopedGaps;
    } else if (matchedPolicyIds.length > 0) {
      // Fallback: legacy gaps uden analyse_id (fra parse-time)
      const { data: legacyGaps } = await db
        .from('forsikring_gaps')
        .select('*')
        .in('policy_id', [...new Set(matchedPolicyIds)])
        .eq('tenant_id', auth.tenantId)
        .order('severity', { ascending: true });
      gaps = legacyGaps ?? [];
    }

    // BIZZ-2084: Hent dækninger så UI'et kan vise med grønt hvad der ER
    // dækket (inkl. dækningssum + selvrisiko) — ikke kun manglerne.
    // BIZZ-2099: Udvidet fra kun matchede policer til ALLE analysens policer,
    // så adresseløse virksomhedspolicer (Cyber, Netbank, Kriminalitet m.fl.)
    // også vises som grønne dæknings-bokse.
    const analysePolicyIds = (policies as Array<{ id: string }>).map((p) => p.id);
    const coveragePolicyIds = [...new Set([...matchedPolicyIds, ...analysePolicyIds])];
    let coverages: unknown[] = [];
    if (coveragePolicyIds.length > 0) {
      const { data: coverageRows } = await db
        .from('forsikring_coverages')
        .select('policy_id, coverage_code, coverage_label, is_covered, sum_dkk, deductible_dkk')
        .in('policy_id', coveragePolicyIds)
        .eq('tenant_id', auth.tenantId)
        .order('coverage_label', { ascending: true });
      coverages = coverageRows ?? [];
    }

    return NextResponse.json({
      analyse: analyseResult.data,
      aktiver: aktiverResult.data ?? [],
      gaps,
      documents,
      policies,
      coverages,
    });
  } catch (err) {
    logger.error('[forsikring/analyser/[id]] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
