/**
 * POST /api/forsikring/analyser — Kør gap-analyse for en kunde.
 * GET  /api/forsikring/analyser — List alle analyser for tenant.
 *
 * BIZZ-1366: Walk koncern → match aktiver mod policer → kør gap-engine
 * → persistér i forsikring_analyser + forsikring_aktiver + forsikring_gaps.
 *
 * @module api/forsikring/analyser
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { getInsuranceApi } from '@/lib/db/insurance';
import { walkKoncern } from '@/app/lib/forsikring/koncernWalk';
import { matchAssetsToPolicies } from '@/app/lib/forsikring/assetMatcher';
import { runGapEngine, computeRiskScore } from '@/app/lib/forsikring/gapEngine';
import type { ForsikringCoverage } from '@/app/lib/forsikring/types';
import {
  runBbrCrossCheck,
  runTinglysningCrossCheck,
  runVurCrossCheck,
} from '@/app/lib/forsikring/crossChecks';
import { logActivity } from '@/app/lib/activityLog';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

/**
 * POST /api/forsikring/analyser
 *
 * Body: { kunde_type: 'virksomhed'|'person', kunde_id: string }
 *
 * @param request - Next.js request
 * @returns { analyse_id: string }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    kunde_type: string;
    kunde_id: string;
    kunde_navn?: string;
    as_of_date?: string;
    /** BIZZ-1404: Dokument-IDs der skal genbruges fra tidligere analyser */
    document_ids?: string[];
    /** BIZZ-1404: Nyligt uploadede dokument-IDs for denne analyse */
    new_document_ids?: string[];
    /** BIZZ-1404: Link til kundesag */
    sag_id?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { kunde_type, kunde_id, kunde_navn, as_of_date, document_ids, new_document_ids, sag_id } =
    body;
  if (!kunde_type || !kunde_id || !['virksomhed', 'person'].includes(kunde_type)) {
    return NextResponse.json({ error: 'Missing or invalid kunde_type/kunde_id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // BIZZ-1355: Parse snapshot-dato for historisk analyse
    const snapshotDate = as_of_date ? new Date(as_of_date) : null;
    if (snapshotDate && Number.isNaN(snapshotDate.getTime())) {
      return NextResponse.json(
        { error: 'Invalid as_of_date format (use YYYY-MM-DD)' },
        { status: 400 }
      );
    }

    // 1. Walk koncern → opdag aktiver (med valgfri snapshot-dato)
    logger.log(
      `[forsikring/analyser] Walking koncern for ${kunde_type} ${kunde_id}${snapshotDate ? ` as of ${as_of_date}` : ''}`
    );
    const aktiver = await walkKoncern(
      kunde_type as 'virksomhed' | 'person',
      kunde_id,
      snapshotDate
    );
    logger.log(`[forsikring/analyser] Fandt ${aktiver.length} aktiver`);

    // Request context for internal API calls (used by address enrichment + cross-checks)
    const proto = request.headers.get('x-forwarded-proto') ?? 'https';
    const host = `${proto}://${request.headers.get('host') ?? 'localhost:3000'}`;
    const cookie = request.headers.get('cookie') ?? '';

    // 1b. Berig ejendom-aktiver med adresser (for matching mod policer)
    const ejendomBfes = aktiver.filter((a) => a.type === 'ejendom' && a.bfe).map((a) => a.bfe!);
    if (ejendomBfes.length > 0) {
      try {
        const addrRes = await fetch(`${host}/api/bfe-addresses?bfes=${ejendomBfes.join(',')}`, {
          headers: { cookie },
          signal: AbortSignal.timeout(10_000),
        });
        if (addrRes.ok) {
          const addrData: Record<
            string,
            {
              adresse: string | null;
              postnr: string | null;
              by: string | null;
              etage: string | null;
              doer: string | null;
            }
          > = await addrRes.json();
          for (const aktiv of aktiver) {
            if (aktiv.type === 'ejendom' && aktiv.bfe) {
              const info = addrData[String(aktiv.bfe)];
              if (info?.adresse) {
                // BIZZ-1441: Inkluder etage/dør i adresse for ejerlejligheder
                const etageDoer = [info.etage, info.doer].filter(Boolean).join(' ');
                const fullAddr = etageDoer ? `${info.adresse}, ${etageDoer}` : info.adresse;
                const postBy = [info.postnr, info.by].filter(Boolean).join(' ');
                aktiv.adresse = postBy ? `${fullAddr}, ${postBy}` : fullAddr;
                aktiv.label = aktiv.adresse;
              }
            }
          }
          logger.log(
            `[forsikring/analyser] Beriget ${Object.keys(addrData).length} ejendomme med adresser`
          );
        }
      } catch (err) {
        // BIZZ-1488/1492/1552: Log fejlen så vi kan diagnosticere når adresse-
        // berigelse fejler (tidligere stille fallback) — aktiver beholder så kun
        // BFE-nummeret som label hvilket fejler alle matches.
        logger.error('[forsikring/analyser] Adresse-berigelse fejlede:', err);
      }
    }

    // 2. Hent policer — BIZZ-1404: scope til valgte dokumenter hvis angivet
    const insurance = await getInsuranceApi(auth.tenantId);
    const scopeDocIds = [...(document_ids ?? []), ...(new_document_ids ?? [])];
    let policer;
    if (scopeDocIds.length > 0) {
      // Kun policer parsed fra de valgte dokumenter
      const allPolicies = await insurance.policies.list();
      policer = allPolicies.filter((p) => p.document_id && scopeDocIds.includes(p.document_id));
      logger.log(
        `[forsikring/analyser] Scoped til ${policer.length} policer fra ${scopeDocIds.length} dokumenter (af ${allPolicies.length} total)`
      );
    } else {
      // Fallback: alle policer (backward compat + første analyse)
      policer = await insurance.policies.list();
    }

    // 3. Match aktiver mod policer
    // BIZZ-1492: Debug-log policy adresser for at diagnosticere 0% match
    for (const p of policer.slice(0, 5)) {
      logger.log(
        `[forsikring/analyser] Policy ${p.policy_number}: property_address="${p.property_address ?? 'NULL'}" policyholder_address="${p.policyholder_address ?? 'NULL'}" property_bfe="${p.property_bfe ?? 'NULL'}"`
      );
    }
    for (const a of aktiver.filter((x) => x.type === 'ejendom').slice(0, 5)) {
      logger.log(
        `[forsikring/analyser] Aktiv ejendom: label="${a.label}" adresse="${a.adresse ?? 'NULL'}" bfe=${a.bfe ?? 'NULL'}`
      );
    }

    const matches = matchAssetsToPolicies(aktiver, policer);
    const insuredCount = matches.filter((m) => m.bestMatch !== null).length;

    // BIZZ-1492: Log match-resultater for debugging
    logger.log(
      `[forsikring/analyser] Matches: ${insuredCount}/${matches.length} forsikrede, ${matches.length - insuredCount} uforsikrede`
    );
    for (const m of matches.filter((x) => x.bestMatch === null).slice(0, 3)) {
      logger.log(
        `[forsikring/analyser] Uforsikret: "${m.aktiv.label}" (type=${m.aktiv.type}, bfe=${m.aktiv.bfe ?? '?'})`
      );
    }

    // 4. Kør gap-engine for matchede aktiver
    const allGaps: Array<{
      policyId: string;
      checkId: string;
      category: string;
      severity: string;
      title: string;
      description: string;
      recommendation: string | null;
      estimatedImpactDkk: number | null;
      sourceData: Record<string, unknown>;
      riskScore: number;
    }> = [];

    // BIZZ-1446: Hent branche-data for virksomheds-aktiver
    const virksomhedAktiver = aktiver.filter((a) => a.type === 'virksomhed' && a.cvr);
    let brancheData:
      | {
          hovedbranche: string | null;
          hovedbranche_tekst: string | null;
          bibrancher: Array<{ kode: string; tekst: string | null }>;
        }
      | undefined;
    if (virksomhedAktiver.length > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: virkData } = await (admin as any)
          .from('cvr_virksomhed')
          .select(
            'branche_kode, branche_tekst, bibranche_1_kode, bibranche_1_tekst, bibranche_2_kode, bibranche_2_tekst, bibranche_3_kode, bibranche_3_tekst'
          )
          .eq('cvr_nummer', virksomhedAktiver[0].cvr)
          .maybeSingle();
        if (virkData) {
          const v = virkData as Record<string, string | null>;
          const bibrancher: Array<{ kode: string; tekst: string | null }> = [];
          for (let i = 1; i <= 3; i++) {
            const kode = v[`bibranche_${i}_kode`];
            if (kode) bibrancher.push({ kode, tekst: v[`bibranche_${i}_tekst`] ?? null });
          }
          brancheData = {
            hovedbranche: v.branche_kode ?? null,
            hovedbranche_tekst: v.branche_tekst ?? null,
            bibrancher,
          };
        }
      } catch {
        /* best-effort */
      }
    }

    // BIZZ-1488/1492/1552: Batch-fetch coverages per policy så gap-engine
    // får faktiske dækningsdata (tidligere hardkodet til []) — uden disse
    // rapporterede checkMissingGlas/Sanitet/etc. altid "mangler".
    const policyIds = matches.filter((m) => m.bestMatch).map((m) => m.bestMatch!.policy.id);
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    if (policyIds.length > 0) {
      const coveragePromises = policyIds.map((id) =>
        insurance.coverages.listForPolicy(id).then((rows) => ({ id, rows }))
      );
      const results = await Promise.all(coveragePromises);
      for (const r of results) coveragesByPolicy.set(r.id, r.rows);
    }

    for (const match of matches) {
      if (!match.bestMatch) continue;
      const policyCoverages = coveragesByPolicy.get(match.bestMatch.policy.id) ?? [];
      const gaps = runGapEngine({
        policy: match.bestMatch.policy,
        coverages: policyCoverages,
        bbr: null,
        asOfDate: new Date(),
        branche: brancheData,
        asset: {
          type: match.aktiv.type,
          vaerdiDkk: match.aktiv.vaerdiDkk,
          haeftelserDkk: match.aktiv.haeftelserDkk,
          byggeaar: match.aktiv.byggeaar,
          matchScore: match.bestMatch.score,
        },
      });
      for (const gap of gaps) {
        allGaps.push({
          policyId: match.bestMatch.policy.id,
          checkId: gap.check_id,
          category: gap.category,
          severity: gap.severity,
          title: gap.title,
          description: gap.description,
          recommendation: gap.recommendation,
          estimatedImpactDkk: gap.estimated_impact_dkk,
          sourceData: gap.source_data,
          riskScore: computeRiskScore(gap, {
            type: match.aktiv.type,
            vaerdiDkk: match.aktiv.vaerdiDkk,
            haeftelserDkk: match.aktiv.haeftelserDkk,
            byggeaar: match.aktiv.byggeaar,
          }),
        });
      }
    }

    // 4b. BIZZ-1356: Auto-trigger eksterne cross-checks (best-effort, parallel)
    try {
      const [bbrResult, tlResult, vurResult] = await Promise.allSettled([
        runBbrCrossCheck(matches, host, cookie),
        runTinglysningCrossCheck(matches, host, cookie),
        runVurCrossCheck(matches, host, cookie),
      ]);

      // Merge cross-check gaps into allGaps
      if (bbrResult.status === 'fulfilled') {
        for (const g of bbrResult.value.gaps) {
          allGaps.push({
            policyId: g.policyId,
            checkId: g.check_id,
            category: g.category,
            severity: g.severity,
            title: g.title,
            description: g.description,
            recommendation: g.recommendation,
            estimatedImpactDkk: g.estimated_impact_dkk,
            sourceData: g.source_data,
            riskScore: g.riskScore,
          });
        }
        logger.log(`[forsikring/analyser] BBR cross-check: ${bbrResult.value.gaps.length} gaps`);
      }
      if (tlResult.status === 'fulfilled') {
        for (const g of tlResult.value.gaps) {
          allGaps.push({
            policyId: g.policyId,
            checkId: g.check_id,
            category: g.category,
            severity: g.severity,
            title: g.title,
            description: g.description,
            recommendation: g.recommendation,
            estimatedImpactDkk: g.estimated_impact_dkk,
            sourceData: g.source_data,
            riskScore: g.riskScore,
          });
        }
        logger.log(
          `[forsikring/analyser] Tinglysning cross-check: ${tlResult.value.gaps.length} gaps`
        );
      }
      if (vurResult.status === 'fulfilled') {
        for (const g of vurResult.value.gaps) {
          allGaps.push({
            policyId: g.policyId,
            checkId: g.check_id,
            category: g.category,
            severity: g.severity,
            title: g.title,
            description: g.description,
            recommendation: g.recommendation,
            estimatedImpactDkk: g.estimated_impact_dkk,
            sourceData: g.source_data,
            riskScore: g.riskScore,
          });
        }
        logger.log(`[forsikring/analyser] VUR cross-check: ${vurResult.value.gaps.length} gaps`);
      }
    } catch (err) {
      logger.warn('[forsikring/analyser] Cross-checks fejlede (best-effort):', err);
    }

    // 5. Beregn samlet risk-score
    const totalRiskScore =
      allGaps.length > 0
        ? Math.round(allGaps.reduce((sum, g) => sum + g.riskScore, 0) / allGaps.length)
        : 0;

    // 6. Persistér analyse
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);
    const { data: analyse, error: analyseErr } = await db
      .from('forsikring_analyser')
      .insert({
        tenant_id: auth.tenantId,
        kunde_type,
        kunde_id,
        kunde_navn: kunde_navn ?? null,
        total_aktiver: aktiver.length,
        insured_count: insuredCount,
        uninsured_count: aktiver.length - insuredCount,
        total_risk_score: totalRiskScore,
        sag_id: sag_id ?? null,
        summary: {
          gaps_count: allGaps.length,
          gaps_critical: allGaps.filter((g) => g.severity === 'critical').length,
          gaps_warning: allGaps.filter((g) => g.severity === 'warning').length,
          policer_count: policer.length,
          as_of_date: as_of_date ?? null,
        },
        created_by: auth.userId,
      })
      .select('id')
      .single();

    if (analyseErr || !analyse) {
      logger.error('[forsikring/analyser] Insert analyse fejl:', analyseErr);
      return NextResponse.json({ error: 'Kunne ikke gemme analyse' }, { status: 500 });
    }

    // 7. Persistér aktiver
    if (aktiver.length > 0) {
      const aktivRows = matches.map((m) => ({
        tenant_id: auth.tenantId,
        analyse_id: analyse.id,
        type: m.aktiv.type,
        label: m.aktiv.label,
        bfe: m.aktiv.bfe ?? null,
        cvr: m.aktiv.cvr ?? null,
        regnr: m.aktiv.regnr ?? null,
        vaerdi_dkk: m.aktiv.vaerdiDkk ?? null,
        haeftelser_dkk: m.aktiv.haeftelserDkk ?? null,
        byggeaar: m.aktiv.byggeaar ?? null,
        ansatte: m.aktiv.ansatte ?? null,
        adresse: m.aktiv.adresse ?? null,
        matched_policy_id: m.bestMatch?.policy.id ?? null,
        match_score: m.bestMatch?.score ?? null,
        raw_data: m.aktiv.rawData ?? null,
      }));

      const { error: aktivErr } = await db.from('forsikring_aktiver').insert(aktivRows);

      if (aktivErr) {
        logger.error('[forsikring/analyser] Insert aktiver fejl:', aktivErr);
      }
    }

    // 8. Persistér gaps (med analyse_id for per-analyse scoping)
    if (allGaps.length > 0) {
      const gapRows = allGaps.map((g) => ({
        tenant_id: auth.tenantId,
        policy_id: g.policyId,
        check_id: g.checkId,
        category: g.category,
        severity: g.severity,
        title: g.title,
        description: g.description,
        recommendation: g.recommendation,
        estimated_impact_dkk: g.estimatedImpactDkk,
        source_data: g.sourceData,
        analyse_id: analyse.id,
      }));

      const { error: gapErr } = await db.from('forsikring_gaps').insert(gapRows);

      if (gapErr) {
        logger.error('[forsikring/analyser] Insert gaps fejl:', gapErr);
      }
    }

    // BIZZ-1404: Link dokumenter til analysen via junction-tabel
    const allDocIds = [...(document_ids ?? []), ...(new_document_ids ?? [])];
    if (allDocIds.length > 0) {
      const docLinks = allDocIds.map((docId) => ({
        tenant_id: auth.tenantId,
        analyse_id: analyse.id,
        document_id: docId,
        source: (document_ids ?? []).includes(docId) ? 'reused' : 'uploaded',
      }));
      const { error: linkErr } = await db.from('forsikring_analyse_documents').insert(docLinks);
      if (linkErr) {
        logger.warn('[forsikring/analyser] Link docs fejl:', linkErr.message);
      }
    }

    logActivity(admin, auth.tenantId, auth.userId, 'page_view', {
      analyse_id: analyse.id,
      kunde_type,
      aktiver: aktiver.length,
      gaps: allGaps.length,
    });

    return NextResponse.json({
      analyse_id: analyse.id,
      total_aktiver: aktiver.length,
      insured_count: insuredCount,
      gaps_count: allGaps.length,
      total_risk_score: totalRiskScore,
    });
  } catch (err) {
    logger.error('[forsikring/analyser] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

/**
 * GET /api/forsikring/analyser — List alle analyser for tenant.
 *
 * @returns { analyser: ForsikringAnalyseRow[] }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // BIZZ-1404: Optional filter by customer
  const kundeId = request.nextUrl.searchParams.get('kunde_id');

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (admin as any)
      .schema(schemaName)
      .from('forsikring_analyser')
      .select('*')
      .eq('tenant_id', auth.tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (kundeId) {
      query = query.eq('kunde_id', kundeId);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('[forsikring/analyser] List fejl:', error);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    return NextResponse.json({ analyser: data ?? [] });
  } catch (err) {
    logger.error('[forsikring/analyser] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
