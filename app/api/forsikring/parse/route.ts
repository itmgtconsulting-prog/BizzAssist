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
import { getTenantContext } from '@/lib/db/tenant';
import { parsePolicyFile, parsePolicyImage, canParseAsText } from '@/app/lib/forsikring/parser';
import { runGapEngine } from '@/app/lib/forsikring/gapEngine';
import { COVERAGE_LABELS_DA, type CoverageCode } from '@/app/lib/forsikring/types';
import { resolveFileType } from '@/app/lib/domainFileTypes';

/** Storage bucket name (matcher upload-route) */
const BUCKET = 'forsikring-documents';

/** Tag længere tid pga. Claude-kald (typisk 10-30 sek for en police-PDF) */
export const maxDuration = 60;

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
  const doc = await insurance.documents.get(documentId);
  if (!doc) {
    return NextResponse.json({ error: 'Dokument ikke fundet' }, { status: 404 });
  }

  // Marker som "parsing" så UI kan vise loader
  await insurance.documents.updateParseStatus(doc.id, 'parsing');

  try {
    // Hent PDF fra Storage
    const admin = createAdminClient();
    const { data: blob, error: dlErr } = await admin.storage
      .from(BUCKET)
      .download(doc.storage_path);
    if (dlErr || !blob) {
      const msg = dlErr?.message ?? 'download returnerede null';
      await insurance.documents.updateParseStatus(doc.id, 'failed', { error: msg });
      logger.error('[forsikring/parse] download fejlede:', msg);
      return NextResponse.json({ error: 'Kunne ikke hente fil' }, { status: 500 });
    }
    const buffer = Buffer.from(await blob.arrayBuffer());

    // Route til text-parser eller vision-parser baseret på filtype
    const fileType = resolveFileType(doc.mime_type, doc.original_name);
    if (!fileType) {
      const errMsg = `Filtype kunne ikke afgøres (mime=${doc.mime_type}, navn=${doc.original_name})`;
      await insurance.documents.updateParseStatus(doc.id, 'failed', { error: errMsg });
      return NextResponse.json({ error: errMsg }, { status: 422 });
    }

    const result =
      fileType === 'image'
        ? await parsePolicyImage(buffer, imageSubtypeFromMime(doc.mime_type), apiKey)
        : canParseAsText(fileType)
          ? await parsePolicyFile(buffer, fileType, apiKey)
          : {
              ok: false as const,
              text: null,
              error: `Filtype ${fileType} understøttes ikke endnu`,
            };

    if (!result.ok) {
      await insurance.documents.updateParseStatus(doc.id, 'failed', {
        error: result.error,
        extractedText: result.text ?? undefined,
      });
      return NextResponse.json({ error: result.error }, { status: 422 });
    }

    // Persistér police
    const parsed = result.policy;
    const policy = await insurance.policies.create({
      document_id: doc.id,
      policy_number: parsed.policy_number,
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
      raw_metadata: { notes: parsed.notes ?? null },
      created_by: auth.userId,
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
        coverage_count: coverages.length,
        gap_count: detectedGaps.length,
      },
    });

    return NextResponse.json({
      policy: {
        id: policy.id,
        policy_number: policy.policy_number,
        insurer_name: policy.insurer_name,
        policyholder_name: policy.policyholder_name,
        property_address: policy.property_address,
      },
      coverages_count: coverages.length,
      gaps_count: detectedGaps.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    await insurance.documents.updateParseStatus(doc.id, 'failed', { error: msg });
    logger.error('[forsikring/parse] uventet fejl:', err);
    return NextResponse.json({ error: 'Parse fejlede' }, { status: 500 });
  }
}
