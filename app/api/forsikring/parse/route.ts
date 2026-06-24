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
import { recordAiUsage } from '@/app/lib/aiTracking';
import { normalizePolicyNumber } from '@/app/lib/forsikring/parser';
import { addressesMatch } from '@/app/lib/forsikring/assetMatcher';
import { parseV2, type V2ParseResult } from '@/app/lib/forsikring/parserV2';
import { resolveFileType } from '@/app/lib/domainFileTypes';

/** Storage bucket name (matcher upload-route) */
const BUCKET = 'forsikring-documents';

/**
 * BIZZ-2081: Øget 120 → 300s — store forsikringsoversigter kan kræve op til
 * 16k output-tokens fra Claude, hvilket ikke kan genereres på 120s.
 */
export const maxDuration = 300;

interface ParseRequestBody {
  document_id?: unknown;
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
  //
  // BIZZ-2163: Tærsklen SKAL være større end maxDuration (300s). Tidligere
  // 3-minutters tærskel var KORTERE end funktionens egen max-køretid, så en
  // stor forsikringsoversigt der lovligt stadig parses efter 3 min blev
  // fejlagtigt markeret "failed" af det NÆSTE uploads cleanup-pass — under
  // batch-upload af mange PDF'er gav det "alle uploads fejler", selvom de
  // reelt fuldførte bagefter. Vi nulstiller derfor kun parses der har
  // overskredet serverless-loftet (300s) + en margin → 6 min.
  const STUCK_PARSE_MS = 6 * 60 * 1000;
  try {
    const allDocs = await insurance.documents.list();
    const now = Date.now();
    for (const d of allDocs) {
      if (d.parse_status === 'parsing' && d.created_at) {
        const age = now - new Date(d.created_at).getTime();
        if (age > STUCK_PARSE_MS) {
          await insurance.documents.updateParseStatus(d.id, 'failed', {
            error: `Timeout: parsing overskred serverless-loftet (>5 min) og blev afbrudt`,
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

    // BIZZ-2141: v2 multi-step pipeline erstatter v1
    const parseStart = Date.now();
    let v2Result: V2ParseResult;
    try {
      v2Result = await parseV2(buffer, apiKey);
    } catch (err) {
      const detail = `v2 parse fejlede: ${err instanceof Error ? err.message : 'unknown'}`;
      await insurance.documents.updateParseStatus(doc.id, 'failed', { error: detail });
      logger.error(`[forsikring/parse] v2 FEJL "${doc.original_name}": ${detail}`);
      return NextResponse.json({ error: detail }, { status: 422 });
    }
    const parseMs = Date.now() - parseStart;

    if (v2Result.insurances.length === 0) {
      const detail = `Ingen forsikringstyper fundet i dokumentet (${parseMs}ms)`;
      await insurance.documents.updateParseStatus(doc.id, 'failed', {
        error: detail,
        extractedText: v2Result.markdown.slice(0, 5000),
      });
      return NextResponse.json({ error: detail }, { status: 422 });
    }

    logger.log(
      `[forsikring/parse] v2 OK "${doc.original_name}" (${parseMs}ms): ` +
        `${v2Result.insurances.length} typer, ` +
        `${v2Result.insurances.reduce((s, i) => s + i.entities.length, 0)} enheder, ` +
        `${v2Result.insurances.reduce((s, i) => s + i.entities.reduce((s2, e) => s2 + e.coverages.length, 0), 0)} dækninger`
    );

    // ─── Map v2-output til policer + coverages ─────────────────
    const createdPolicies: Array<{ id: string; policy_number: string }> = [];
    const totalGaps = 0;
    const COVERAGE_CODE_MAP: Record<string, string> = {
      brand: 'brand_el',
      'brand inkl. el-skade': 'brand_el',
      'el-skade': 'brand_el',
      bygningskasko: 'bygningskasko',
      'storm og nedbør': 'bygningskasko',
      storm: 'bygningskasko',
      'udstrømning af vand': 'udvidet_roerskade',
      rørskade: 'udvidet_roerskade',
      vand: 'udvidet_roerskade',
      glas: 'glas',
      sanitet: 'sanitet',
      insekt: 'insekt_svamp',
      svamp: 'insekt_svamp',
      'insekt og svamp': 'insekt_svamp',
      restværdi: 'restvaerdi',
      stikledning: 'stikledning',
      jordskade: 'jordskade',
      lovliggørelse: 'lovliggoerelse',
      huslejetab: 'huslejetab',
      hærværk: 'haerverk',
      'omstilling af låse': 'omstilling_laase',
      låseomstilling: 'omstilling_laase',
      'hus- og grundejeransvar': 'hus_grundejer_ansvar',
      grundejeransvar: 'hus_grundejer_ansvar',
      forurening: 'forurening',
      'forurening (fra forsikringsstedet)': 'forurening',
      driftstab: 'driftstab',
      erhvervsansvar: 'erhvervsansvar',
      'udvidet vandskade': 'udvidet_vandskade',
      løsøre: 'loesoere',
      erhvervsløsøre: 'loesoere',
      indbrud: 'indbrudstyveri',
      tyveri: 'indbrudstyveri',
      indbrudstyveri: 'indbrudstyveri',
      'ran og røveri': 'ran_roeveri',
      oprydning: 'oprydning',
      cyber: 'cyber',
      netbank: 'netbank',
      kriminalitet: 'kriminalitet',
      transport: 'transport',
      'maskiner og it-udstyr': 'maskiner_itudstyr',
      ansvar: 'erhvervsansvar',
      fareafværgelse: 'forurening',
      'fareafværgelse (erhvervs- og produktansvar)': 'forurening',
      retshjælp: 'kriminalitet',
      'pludselig skade': 'brand_el',
      // BIZZ-2154: Motor-/køretøjsdækninger — egne koder så bilpolicer ikke
      // fejlklassificeres som ejendomsforsikring. "kasko" alene = motorkasko
      // ("bygningskasko" matches eksakt ovenfor og rammes ikke her).
      kasko: 'motorkasko',
      'kasko (bil)': 'motorkasko',
      førerulykke: 'foererulykke',
      friskade: 'friskade',
      'redning i udlandet': 'redning_udland',
      redning: 'redning_udland',
      'eftermonteret tilbehør': 'eftermonteret_udstyr',
      'eftermonteret udstyr': 'eftermonteret_udstyr',
    };

    /** Map et dæknings-navn til nærmeste coverage_code */
    function mapCoverageCode(navn: string): string {
      const lower = navn.toLowerCase().trim();
      // Eksakt match
      if (COVERAGE_CODE_MAP[lower]) return COVERAGE_CODE_MAP[lower];
      // Partial match
      for (const [key, code] of Object.entries(COVERAGE_CODE_MAP)) {
        if (lower.includes(key) || key.includes(lower)) return code;
      }
      // Default baseret på type
      if (lower.includes('brand') || lower.includes('el-skade')) return 'brand_el';
      if (lower.includes('storm') || lower.includes('nedbør')) return 'bygningskasko';
      if (lower.includes('vand') || lower.includes('rør')) return 'udvidet_roerskade';
      if (lower.includes('ansvar')) return 'erhvervsansvar';
      if (lower.includes('tyveri') || lower.includes('indbrud')) return 'indbrudstyveri';
      return 'brand_el'; // fallback
    }

    for (const ins of v2Result.insurances) {
      const policyNumber = normalizePolicyNumber(ins.identification.policenummer ?? '0');

      for (const ent of ins.entities) {
        // Check for existing policy (dedup)
        const existingAll = await insurance.policies.findAllByNumber(policyNumber);
        let existing = existingAll.find((p) =>
          ent.entity.adresse ? addressesMatch(p.property_address, ent.entity.adresse) : false
        );
        // Fallback: match on insurance type alone for non-property types
        if (!existing && !ent.entity.adresse) {
          const normType = ins.identification.type.toLowerCase();
          existing = existingAll.find((p) =>
            (p.business_activity ?? '').toLowerCase().includes(normType.split('forsikring')[0])
          );
        }

        // BIZZ-2154: Ryd op i duplikerede police-rækker for SAMME forsikringssted.
        // Tidligere dobbelt-parsninger kunne efterlade to rækker med samme
        // policenummer og samme sted (fx en bilpolice uden adresse), hvor den
        // ene beholdt forældede dækningskoder. Det forurener forsikringstype-
        // udledningen (bil-police vist som ejendomsforsikring). Behold den
        // matchede række og slet øvrige rækker der dækker præcis samme sted.
        // Multi-forsikringssteder (samme nr., FORSKELLIG adresse) bevares.
        if (existing) {
          const samePlace = (p: { property_address: string | null }) =>
            ent.entity.adresse
              ? addressesMatch(p.property_address, ent.entity.adresse)
              : !p.property_address;
          for (const dup of existingAll) {
            if (dup.id !== existing.id && samePlace(dup)) {
              await insurance.policies.delete(dup.id).catch(() => {});
            }
          }
        }

        if (existing && ent.coverages.length === 0) {
          createdPolicies.push({ id: existing.id, policy_number: existing.policy_number });
          continue;
        }

        // Opret eller opdater police
        const policyId = existing?.id;
        let policy: { id: string; policy_number: string };

        if (existing) {
          policy = { id: existing.id, policy_number: existing.policy_number };
          // BIZZ-2144: Policen dedup-genbruges, men metadata skal opdateres med
          // nyeste parse — ellers mangler fx registreringsnummer på bilpolicer
          // der blev parset før reg.nr-feltet blev gemt.
          await insurance.policies.updateRawMetadata(existing.id, {
            source_type: 'v2',
            insurance_type: ins.identification.type,
            bygninger: ent.entity.bygninger ?? null,
            registreringsnummer: ent.entity.registreringsnummer ?? null,
          });
        } else {
          policy = await insurance.policies.create({
            document_id: doc.id,
            policy_number: policyNumber,
            insurer_name: ins.identification.selskab ?? 'Ukendt',
            insurer_cvr: null,
            broker_name: null,
            policyholder_name: ins.identification.forsikringstager ?? 'Ukendt',
            policyholder_cvr: ins.identification.forsikringstager_cvr ?? null,
            policyholder_address: null,
            property_address: ent.entity.adresse ?? null,
            property_matrikel: null,
            property_bfe: ent.entity.bfe ?? null,
            property_entity_id: null,
            business_activity: ins.identification.type ?? null,
            building_use: ent.entity.bygninger?.[0]?.anvendelse ?? null,
            building_area_m2: ent.entity.bygninger?.[0]?.bebygget_areal_m2 ?? null,
            building_floors: ent.entity.bygninger?.[0]?.antal_etager ?? null,
            building_year_built: ent.entity.bygninger?.[0]?.opfoert_aar ?? null,
            building_has_basement: ent.entity.bygninger?.[0]?.kaelder ?? null,
            insurance_form:
              ent.entity.bygninger?.[0]?.forsikringsform === 'Nyværdi'
                ? ('nyvaerdi' as const)
                : ent.entity.bygninger?.[0]?.forsikringsform === 'Sum'
                  ? ('sum' as const)
                  : null,
            sum_insured_dkk: null,
            annual_premium_dkk: null,
            general_deductible_dkk: null,
            effective_from: null,
            effective_to: null,
            main_renewal_date: null,
            policy_issued_date: null,
            raw_metadata: {
              source_type: 'v2',
              insurance_type: ins.identification.type,
              bygninger: ent.entity.bygninger ?? null,
              // BIZZ-2144: Gem reg.nr fra bilpolicer så UI kan linke til
              // motorregisterets åbne opslag.
              registreringsnummer: ent.entity.registreringsnummer ?? null,
            },
            created_by: auth.userId,
            sag_id: docSagId,
          });
        }

        // Gem coverages
        if (ent.coverages.length > 0) {
          // Slet eksisterende coverages hvis vi opdaterer
          if (policyId) {
            try {
              await insurance.coverages.deleteForPolicy(policyId);
            } catch {
              /* ignore */
            }
          }

          const coverageInputs = ent.coverages.map((c) => ({
            policy_id: policy.id,
            coverage_code: mapCoverageCode(c.navn),
            coverage_label: c.navn,
            is_covered: c.er_daekket,
            sum_dkk: c.sum_dkk ?? null,
            deductible_dkk: c.selvrisiko_dkk ?? null,
            conditions_ref: c.betingelsesref ?? null,
            notes: c.noter ?? null,
          }));

          await insurance.coverages.bulkCreate(coverageInputs);
        }

        createdPolicies.push({ id: policy.id, policy_number: policy.policy_number });
      }
    }

    // Gem betingelsesreferencer i metadata (for betingelses-tracker)
    if (v2Result.conditions.length > 0) {
      logger.log(
        `[forsikring/parse] v2 betingelser: ${v2Result.conditions.map((c) => c.ref).join(', ')}`
      );
    }

    // BIZZ-2190: Registrér FAKTISK token-forbrug (sum af de 5 Claude-kald) mod
    // brugerens månedskvote via recordAiUsage — som standard-docs-routerne. Den
    // gamle recordParseTokens estimerede input fra markdown-længde, satte output=0
    // og opdaterede ALDRIG app_metadata.tokensUsedThisMonth (billing-læk: parse
    // skubbede aldrig brugeren over kvoten).
    void recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'ai.forsikring-parse',
      inputTokens: v2Result.usage?.inputTokens ?? 0,
      outputTokens: v2Result.usage?.outputTokens ?? 0,
      model: 'claude-sonnet-4-6',
    });

    await insurance.documents.updateParseStatus(doc.id, 'parsed', {
      extractedText: v2Result.markdown.slice(0, 5000),
    });

    return NextResponse.json({
      policies_count: createdPolicies.length,
      document_type: 'v2',
      gaps_count: totalGaps,
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
