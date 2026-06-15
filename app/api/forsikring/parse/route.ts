/**
 * POST /api/forsikring/parse
 *
 * Parse en allerede uploaded PDF til en struktureret police via Claude.
 * Persisterer:
 *   1. forsikring_policies (1 row)
 *   2. forsikring_coverages (N rows fra parser)
 *   3. forsikring_gaps (M rows fra gap-engine v1, BBR-frit)
 *   4. forsikring_documents.parse_status = parsed | failed
 *
 * BBR-baseret gap-detektion (areal-afvigelse, anvendelse-mismatch) kører
 * IKKE i denne route — kræver opslag mod ekstern API. Den kan trigges
 * separat via POST /api/forsikring/[id]/gaps når property_bfe er sat.
 *
 * Body: { document_id: string }
 *
 * @returns { policy: { id, policy_number, ... }, gaps_count: number }
 *
 * @module api/forsikring/parse
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import { getInsuranceApi } from '@/lib/db/insurance';
import { getTenantContext, getTenantSchemaName } from '@/lib/db/tenant';
import {
  parsePolicyImage,
  canParseAsText,
  parseWithTypeDetection,
  normalizePolicyNumber,
  oversigtEntryMatchesPolicy,
  type MultiParseResult,
} from '@/app/lib/forsikring/parser';
import { runGapEngine } from '@/app/lib/forsikring/gapEngine';
import {
  COVERAGE_LABELS_DA,
  type CoverageCode,
  type ForsikringCoverage,
  type ParsedPolicy,
} from '@/app/lib/forsikring/types';
import { resolveFileType } from '@/app/lib/domainFileTypes';

/** Storage bucket name (matcher upload-route) */
const BUCKET = 'forsikring-documents';

/**
 * BIZZ-1404: Record AI token usage for forsikring parse operations.
 * Fire-and-forget — failures silently swallowed.
 */
function recordParseTokens(
  tenantId: string,
  userId: string,
  tokensIn: number,
  tokensOut: number
): void {
  if (tokensIn === 0 && tokensOut === 0) return;
  void (async () => {
    try {
      const schemaName = await getTenantSchemaName(tenantId);
      const admin = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).schema(schemaName).from('ai_token_usage').insert({
        tenant_id: tenantId,
        user_id: userId,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        model: 'claude-sonnet-4-6',
      });
    } catch {
      // Non-critical — best-effort tracking
    }
  })();
}

/**
 * BIZZ-2081: Øget 120 → 300s — store forsikringsoversigter kan kræve op til
 * 16k output-tokens fra Claude, hvilket ikke kan genereres på 120s.
 */
export const maxDuration = 300;

interface ParseRequestBody {
  document_id?: unknown;
}

/**
 * Udled billed-subtype fra MIME-type. Bruges af Claude vision-routing.
 *
 * @param mime - Fuld MIME-type fra dokument-row (fx "image/jpeg")
 * @returns Subtype-streng ("jpg", "png", ...) eller "png" som default
 */
function imageSubtypeFromMime(mime: string): string {
  if (!mime) return 'png';
  const sub = mime.split('/')[1]?.toLowerCase() ?? 'png';
  // Normalisér aliaser
  if (sub === 'jpeg') return 'jpg';
  return sub;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // BIZZ-1383: AI billing gate — afvis før Claude-kald
  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  const limited = await checkRateLimit(request, aiRateLimit);
  if (limited) return limited;

  let body: ParseRequestBody;
  try {
    body = (await request.json()) as ParseRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.document_id !== 'string' || body.document_id.length === 0) {
    return NextResponse.json({ error: 'document_id påkrævet' }, { status: 400 });
  }
  const documentId = body.document_id;

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    logger.error('[forsikring/parse] BIZZASSIST_CLAUDE_KEY ikke sat');
    return NextResponse.json({ error: 'AI-tjeneste ikke konfigureret' }, { status: 500 });
  }

  const insurance = await getInsuranceApi(auth.tenantId);

  // Cleanup stuck "parsing" docs (Vercel timeout dræber processen uden at
  // catch-blokken kører → status forbliver "parsing" permanent).
  // Reset docs der har været "parsing" i >3 min til "failed".
  try {
    const allDocs = await insurance.documents.list();
    const now = Date.now();
    for (const d of allDocs) {
      if (d.parse_status === 'parsing' && d.created_at) {
        const age = now - new Date(d.created_at).getTime();
        if (age > 3 * 60 * 1000) {
          await insurance.documents.updateParseStatus(d.id, 'failed', {
            error: `Timeout: parsing brugte mere end 3 minutter (sandsynligvis Vercel serverless timeout)`,
          });
          logger.warn(
            `[forsikring/parse] Reset stuck doc "${d.original_name}" (${d.id}) fra parsing → failed`
          );
        }
      }
    }
  } catch {
    // Cleanup er non-fatal
  }

  const doc = await insurance.documents.get(documentId);
  if (!doc) {
    return NextResponse.json({ error: 'Dokument ikke fundet' }, { status: 404 });
  }
  // BIZZ-1399: sag_id fra dokumentet propageres til policer
  const docSagId = (doc as unknown as Record<string, unknown>).sag_id as string | undefined;

  // Marker som "parsing" så UI kan vise loader
  await insurance.documents.updateParseStatus(doc.id, 'parsing');

  try {
    // Hent PDF fra Storage
    logger.log(
      `[forsikring/parse] Start: docId=${documentId} fil="${doc.original_name}" mime=${doc.mime_type} path=${doc.storage_path}`
    );
    const admin = createAdminClient();
    const { data: blob, error: dlErr } = await admin.storage
      .from(BUCKET)
      .download(doc.storage_path);
    if (dlErr || !blob) {
      const msg = dlErr?.message ?? 'download returnerede null';
      await insurance.documents.updateParseStatus(doc.id, 'failed', {
        error: `Download fejl: ${msg}`,
      });
      logger.error(`[forsikring/parse] Download fejlede for "${doc.original_name}":`, msg);
      return NextResponse.json({ error: 'Kunne ikke hente fil', detail: msg }, { status: 500 });
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    logger.log(`[forsikring/parse] Downloaded "${doc.original_name}": ${buffer.length} bytes`);

    // Route til text-parser eller vision-parser baseret på filtype
    const fileType = resolveFileType(doc.mime_type, doc.original_name);
    if (!fileType) {
      const errMsg = `Filtype kunne ikke afgøres (mime=${doc.mime_type}, navn=${doc.original_name})`;
      await insurance.documents.updateParseStatus(doc.id, 'failed', { error: errMsg });
      logger.error(`[forsikring/parse] Filtype ukendt for "${doc.original_name}": ${errMsg}`);
      return NextResponse.json({ error: errMsg, detail: errMsg }, { status: 422 });
    }
    logger.log(
      `[forsikring/parse] Filtype="${fileType}" for "${doc.original_name}" (${buffer.length} bytes) — sender til Claude`
    );

    // BIZZ-1392: 2-trins pipeline — detektér dokumenttype, derefter parse
    let result: MultiParseResult;
    const parseStart = Date.now();
    if (fileType === 'image') {
      // Billeder kan ikke gennemgå trin 1 — parse direkte som police
      result = await parsePolicyImage(buffer, imageSubtypeFromMime(doc.mime_type), apiKey);
    } else if (canParseAsText(fileType)) {
      result = await parseWithTypeDetection(buffer, fileType, apiKey);
    } else {
      result = { ok: false, text: null, error: `Filtype ${fileType} understøttes ikke endnu` };
    }
    const parseMs = Date.now() - parseStart;

    if (!result.ok) {
      const detail = `Parse fejlede efter ${parseMs}ms: ${result.error}`;
      await insurance.documents.updateParseStatus(doc.id, 'failed', {
        error: detail,
        extractedText: result.text ?? undefined,
      });
      logger.error(
        `[forsikring/parse] FEJL "${doc.original_name}" (${parseMs}ms): ${result.error}`
      );
      return NextResponse.json({ error: result.error, detail }, { status: 422 });
    }
    logger.log(
      `[forsikring/parse] OK "${doc.original_name}" parsed i ${parseMs}ms — type=${'oversigt' in result ? 'oversigt' : result.documentType}`
    );

    // BIZZ-1392: Håndtér baseret på dokumenttype
    if ('oversigt' in result) {
      // ─── Oversigt: opret N policer fra ét dokument ───────────
      const { oversigt } = result;
      const createdPolicies: Array<{ id: string; policy_number: string }> = [];
      let totalGaps = 0;

      for (const entry of oversigt.policies) {
        // BIZZ-1395: Normalisér policenummer og skip duplikater
        // BIZZ-1908: Same policenr kan have flere entries med forskellige
        // forsikringstyper/adresser (fx ansvar + ejendom under same aftalenr).
        // BIZZ-2097 FIX: Dedup på policenr + adresse + forsikringstype — adresseløse
        // typer (Cyber, Netbank, Driftstab, Kriminalitet) under samme aftalenr blev
        // kollapset af adresse-eneste sammenligningen (null === null). Sammenlign
        // desuden mod ALLE eksisterende policer med nummeret, ikke kun den nyeste.
        const normalizedNum = normalizePolicyNumber(entry.policy_number);
        const existingAll = await insurance.policies.findAllByNumber(normalizedNum);

        // BIZZ-2129: Entry-dækninger udregnes her, så de kan bruges både til
        // coverage-set-dedup nedenfor og til persisteringen længere nede.
        const entryCoverages = (entry as Record<string, unknown>).coverages as
          | Array<{
              coverage_code: string;
              coverage_label?: string;
              is_covered: boolean;
              sum_dkk?: number | null;
              deductible_dkk?: number | null;
            }>
          | undefined;
        const entryCodeSet = new Set((entryCoverages ?? []).map((c) => c.coverage_code));

        // Primær dedup: samme adresse + forsikringstype (BIZZ-2097).
        let existing = existingAll.find((p) => oversigtEntryMatchesPolicy(p, entry));

        // Sekundær dedup: ikke-ejendomsspecifikke policer (ansvar, drift, cyber
        // etc.) er virksomheds-dækkende — match på forsikringstype alene uanset
        // adresse. Ejendomsforsikringer er adresse-specifikke og kræver stadig
        // adresse-match (håndteres af primær dedup ovenfor).
        if (!existing) {
          const normT = (s: string | null | undefined) => s?.trim().toLowerCase() || null;
          const entryType = normT(entry.insurance_type);
          const isPropertySpecific = entryType && /ejendom/i.test(entryType);
          if (!isPropertySpecific && entryType) {
            existing = existingAll.find((p) => normT(p.business_activity) === entryType) ?? null;
          }
        }

        // BIZZ-2129: Tertiær dedup på DÆKNINGSSÆT — samme aftalenr + samme
        // forsikringssted + identisk sæt af coverage_codes = duplikat, selv når
        // type-labels varierer ("Erhvervsansvar" fra police-PDF vs
        // "Ansvarsforsikring" fra oversigt-PDF). Cyber vs Netbank (forskellige
        // dækninger) forbliver adskilt.
        if (!existing && entryCodeSet.size > 0) {
          const normA = (s: string | null | undefined) => s?.trim().toLowerCase() || null;
          for (const p of existingAll) {
            if (normA(p.property_address) !== normA(entry.property_address)) continue;
            const exCovs = await insurance.coverages.listForPolicy(p.id);
            const exCodes = new Set(exCovs.map((c) => c.coverage_code));
            if (
              exCodes.size === entryCodeSet.size &&
              [...entryCodeSet].every((c) => exCodes.has(c))
            ) {
              existing = p;
              break;
            }
          }
        }
        if (existing) {
          createdPolicies.push({ id: existing.id, policy_number: existing.policy_number });
          continue;
        }

        const policy = await insurance.policies.create({
          document_id: doc.id,
          policy_number: normalizedNum,
          insurer_name: entry.insurer_name,
          insurer_cvr: entry.insurer_cvr ?? null,
          broker_name: oversigt.broker_name ?? null,
          policyholder_name: entry.policyholder_name,
          policyholder_cvr: entry.policyholder_cvr ?? null,
          policyholder_address: null,
          property_address: entry.property_address ?? null,
          property_matrikel: null,
          property_bfe: null,
          property_entity_id: null,
          business_activity: entry.insurance_type ?? null,
          building_use: null,
          building_area_m2: null,
          building_floors: null,
          building_year_built: null,
          building_has_basement: null,
          insurance_form: null,
          sum_insured_dkk: entry.sum_insured_dkk ?? null,
          annual_premium_dkk: entry.annual_premium_dkk ?? null,
          general_deductible_dkk: null,
          effective_from: entry.effective_from ?? null,
          effective_to: entry.effective_to ?? null,
          main_renewal_date: null,
          policy_issued_date: null,
          raw_metadata: {
            source_type: 'oversigt',
            notes: entry.notes ?? null,
            overview_notes: oversigt.notes ?? null,
          },
          created_by: auth.userId,
          sag_id: docSagId,
        });

        // Gem coverages fra oversigt (hvis AI returnerede dem) — entryCoverages
        // er udregnet ovenfor (BIZZ-2129).
        const coverageInputs = (entryCoverages ?? []).map((c) => ({
          policy_id: policy.id,
          coverage_code: c.coverage_code,
          coverage_label:
            c.coverage_label ||
            COVERAGE_LABELS_DA[c.coverage_code as CoverageCode] ||
            c.coverage_code,
          is_covered: c.is_covered,
          sum_dkk: c.sum_dkk ?? null,
          deductible_dkk: c.deductible_dkk ?? null,
          conditions_ref: null,
          notes: null,
        }));
        if (coverageInputs.length > 0) {
          await insurance.coverages.bulkCreate(coverageInputs);
        }

        // Kør gap-engine med dækningsdata fra oversigt
        await insurance.gaps.deleteForPolicy(policy.id);
        const detectedGaps = runGapEngine({
          policy,
          coverages: coverageInputs as unknown as ForsikringCoverage[],
          bbr: null,
          asOfDate: new Date(),
        });
        if (detectedGaps.length > 0) {
          await insurance.gaps.bulkCreate(
            detectedGaps.map((g) => ({
              policy_id: policy.id,
              check_id: g.check_id,
              category: g.category,
              severity: g.severity,
              title: g.title,
              description: g.description,
              recommendation: g.recommendation,
              estimated_impact_dkk: g.estimated_impact_dkk,
              source_data: g.source_data,
            }))
          );
          totalGaps += detectedGaps.length;
        }

        createdPolicies.push({ id: policy.id, policy_number: policy.policy_number });
      }

      // Markér dokument som parsed (link til første police)
      await insurance.documents.updateParseStatus(doc.id, 'parsed', {
        extractedText: result.text,
        policyId: createdPolicies[0]?.id,
      });

      // Audit log
      const ctx = await getTenantContext(auth.tenantId);
      await ctx.auditLog.write({
        action: 'forsikring.oversigt.parsed',
        resource_type: 'forsikring_document',
        resource_id: doc.id,
        metadata: {
          document_type: 'oversigt',
          policies_created: createdPolicies.length,
          total_gaps: totalGaps,
        },
      });

      // BIZZ-1404: Registrer AI token-forbrug
      if (result.tokenUsage) {
        recordParseTokens(
          auth.tenantId,
          auth.userId,
          result.tokenUsage.input,
          result.tokenUsage.output
        );
      }

      return NextResponse.json({
        document_type: 'oversigt',
        policies: createdPolicies,
        policies_count: createdPolicies.length,
        gaps_count: totalGaps,
        tokenUsage: result.tokenUsage ?? null,
      });
    }

    // ─── Individuel police (police/tillaeg/ukendt) ─────────────
    const parsed: ParsedPolicy = result.policy;
    // BIZZ-1395: Normalisér policenummer og dedup mod eksisterende
    const normalizedPolicyNum = normalizePolicyNumber(parsed.policy_number);
    const existingPolicy = await insurance.policies.findByNumber(normalizedPolicyNum);
    if (existingPolicy) {
      // Police eksisterer allerede — link dokumentet og TILFØJ coverages
      // hvis det nye dokument har dækningsdata (typisk detaljeret police vs oversigt)
      let addedCoverages = 0;
      if (parsed.coverages && parsed.coverages.length > 0) {
        // Slet gamle (tomme) coverages og indsæt nye fra det detaljerede dokument
        await insurance.coverages.deleteForPolicy(existingPolicy.id);
        const coverageInputs = parsed.coverages.map(
          (c: {
            coverage_code: string;
            coverage_label?: string;
            is_covered: boolean;
            sum_dkk?: number | null;
            deductible_dkk?: number | null;
            conditions_ref?: string | null;
            notes?: string | null;
          }) => ({
            policy_id: existingPolicy.id,
            coverage_code: c.coverage_code,
            coverage_label:
              c.coverage_label ||
              COVERAGE_LABELS_DA[c.coverage_code as CoverageCode] ||
              c.coverage_code,
            is_covered: c.is_covered,
            sum_dkk: c.sum_dkk ?? null,
            deductible_dkk: c.deductible_dkk ?? null,
            conditions_ref: c.conditions_ref ?? null,
            notes: c.notes ?? null,
          })
        );
        await insurance.coverages.bulkCreate(coverageInputs);
        addedCoverages = coverageInputs.length;

        // Re-kør gap-engine med dækningsdata
        await insurance.gaps.deleteForPolicy(existingPolicy.id);
        const detectedGaps = runGapEngine({
          policy: existingPolicy,
          coverages: coverageInputs as unknown as ForsikringCoverage[],
          bbr: null,
          asOfDate: new Date(),
        });
        if (detectedGaps.length > 0) {
          await insurance.gaps.bulkCreate(
            detectedGaps.map((g) => ({
              policy_id: existingPolicy.id,
              check_id: g.check_id,
              category: g.category,
              severity: g.severity,
              title: g.title,
              description: g.description,
              recommendation: g.recommendation,
              estimated_impact_dkk: g.estimated_impact_dkk,
              source_data: g.source_data,
            }))
          );
        }
      }

      await insurance.documents.updateParseStatus(doc.id, 'parsed', {
        extractedText: result.text,
        policyId: existingPolicy.id,
      });
      return NextResponse.json({
        document_type: result.documentType,
        policy: {
          id: existingPolicy.id,
          policy_number: existingPolicy.policy_number,
          insurer_name: existingPolicy.insurer_name,
          policyholder_name: existingPolicy.policyholder_name,
          property_address: existingPolicy.property_address,
        },
        deduplicated: true,
        coverages_count: addedCoverages,
        gaps_count: 0,
      });
    }

    const policy = await insurance.policies.create({
      document_id: doc.id,
      policy_number: normalizedPolicyNum,
      insurer_name: parsed.insurer_name,
      insurer_cvr: parsed.insurer_cvr ?? null,
      broker_name: parsed.broker_name ?? null,
      policyholder_name: parsed.policyholder_name,
      policyholder_cvr: parsed.policyholder_cvr ?? null,
      policyholder_address: parsed.policyholder_address ?? null,
      property_address: parsed.property_address ?? null,
      property_matrikel: parsed.property_matrikel ?? null,
      property_bfe: parsed.property_bfe ?? null,
      property_entity_id: null,
      business_activity: parsed.business_activity ?? null,
      building_use: parsed.building_use ?? null,
      building_area_m2: parsed.building_area_m2 ?? null,
      building_floors: parsed.building_floors ?? null,
      building_year_built: parsed.building_year_built ?? null,
      building_has_basement: parsed.building_has_basement ?? null,
      insurance_form: parsed.insurance_form ?? null,
      sum_insured_dkk: parsed.sum_insured_dkk ?? null,
      annual_premium_dkk: parsed.annual_premium_dkk ?? null,
      general_deductible_dkk: parsed.general_deductible_dkk ?? null,
      effective_from: parsed.effective_from ?? null,
      effective_to: parsed.effective_to ?? null,
      main_renewal_date: parsed.main_renewal_date ?? null,
      policy_issued_date: parsed.policy_issued_date ?? null,
      raw_metadata: {
        document_type: result.documentType,
        notes: parsed.notes ?? null,
        // BIZZ-2120: Sikrede/medforsikrede virksomheder fra policen — bruges
        // af assetMatcher til pr.-selskab virksomheds-match (aldrig bredt).
        insured_companies: parsed.insured_companies ?? null,
      },
      created_by: auth.userId,
      sag_id: docSagId,
    });

    // Persistér dækninger (også eksplicit ekskluderede med is_covered=false)
    const coverageInputs = parsed.coverages.map((c) => ({
      policy_id: policy.id,
      coverage_code: c.coverage_code,
      coverage_label:
        c.coverage_label || COVERAGE_LABELS_DA[c.coverage_code as CoverageCode] || c.coverage_code,
      is_covered: c.is_covered,
      sum_dkk: c.sum_dkk ?? null,
      deductible_dkk: c.deductible_dkk ?? null,
      conditions_ref: c.conditions_ref ?? null,
      notes: c.notes ?? null,
    }));
    const coverages = await insurance.coverages.bulkCreate(coverageInputs);

    // Markér dokument som parsed + link til police
    await insurance.documents.updateParseStatus(doc.id, 'parsed', {
      extractedText: result.text,
      policyId: policy.id,
    });

    // Kør gap-engine v1 (BBR-frit — kun coverage og dato-baserede checks)
    // BIZZ-1391: Slet eksisterende gaps for policen før re-indsættelse (dedup)
    await insurance.gaps.deleteForPolicy(policy.id);
    const detectedGaps = runGapEngine({
      policy,
      coverages,
      bbr: null,
      asOfDate: new Date(),
    });
    if (detectedGaps.length > 0) {
      await insurance.gaps.bulkCreate(
        detectedGaps.map((g) => ({
          policy_id: policy.id,
          check_id: g.check_id,
          category: g.category,
          severity: g.severity,
          title: g.title,
          description: g.description,
          recommendation: g.recommendation,
          estimated_impact_dkk: g.estimated_impact_dkk,
          source_data: g.source_data,
        }))
      );
    }

    // Audit log
    const ctx = await getTenantContext(auth.tenantId);
    await ctx.auditLog.write({
      action: 'forsikring.policy.parsed',
      resource_type: 'forsikring_policy',
      resource_id: policy.id,
      metadata: {
        document_id: doc.id,
        document_type: result.documentType,
        coverage_count: coverages.length,
        gap_count: detectedGaps.length,
      },
    });

    // BIZZ-1404: Registrer AI token-forbrug
    if (result.tokenUsage) {
      recordParseTokens(
        auth.tenantId,
        auth.userId,
        result.tokenUsage.input,
        result.tokenUsage.output
      );
    }

    return NextResponse.json({
      document_type: result.documentType,
      policy: {
        id: policy.id,
        policy_number: policy.policy_number,
        insurer_name: policy.insurer_name,
        policyholder_name: policy.policyholder_name,
        property_address: policy.property_address,
      },
      coverages_count: coverages.length,
      gaps_count: detectedGaps.length,
      tokenUsage: result.tokenUsage ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' → ') : '';
    const detail = `Uventet fejl: ${msg}${stack ? ` [${stack}]` : ''}`;
    await insurance.documents.updateParseStatus(doc.id, 'failed', { error: detail });
    logger.error(
      `[forsikring/parse] CRASH "${doc.original_name}" (docId=${documentId}): ${msg}`,
      stack
    );
    return NextResponse.json({ error: 'Parse fejlede', detail }, { status: 500 });
  }
}
