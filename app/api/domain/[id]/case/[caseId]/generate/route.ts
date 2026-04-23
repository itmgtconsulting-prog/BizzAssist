/**
 * Document generation — POST → Claude → docx fill → storage.
 *
 * BIZZ-717: Takes a template + case + optional user instructions, runs
 * the buildGenerationContext composer (BIZZ-716), calls Claude, validates
 * the output against the strict GenerationOutputSchema (BIZZ-734), fills
 * the template's docx with docxtemplater, uploads the result, and records
 * a domain_generation row.
 *
 * Synchronous endpoint — returns once generation + storage are both done.
 * Streaming SSE is deferred to a follow-up; p95 latency of ~60s for a 5-page
 * output is acceptable via a normal POST with Vercel's 60s function cap.
 *
 * @module api/domain/[id]/case/[caseId]/generate
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { assertDomainAiAllowed } from '@/app/lib/domainAiGate';
import { buildGenerationContext } from '@/app/lib/domainPromptBuilder';
import {
  parseGenerationOutput,
  scanSuspiciousContent,
  type GenerationOutput,
} from '@/app/lib/domainGenerationSchema';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string; caseId: string }> };

/** Claude model to use. Opus 4.6 matches the rest of the codebase. */
const CLAUDE_MODEL = 'claude-opus-4-6';
/** Max tokens Claude may produce — bounds generation cost per call. */
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Fills a .docx template buffer with placeholder values via docxtemplater.
 * Returns the rendered docx bytes. Non-.docx templates (pdf/txt) are
 * returned without fill — placeholders are stringified next to them in the
 * domain_generation.output_path metadata.
 */
async function fillDocx(
  templateBuffer: Buffer,
  fileType: string,
  placeholders: Record<string, string>
): Promise<{ buffer: Buffer; ext: string }> {
  if (fileType !== 'docx') {
    // Non-docx templates aren't truly filled — return the source as-is so
    // the reviewer can manually paste the generated content.
    return { buffer: templateBuffer, ext: fileType };
  }
  const PizZip = (await import('pizzip')).default;
  const Docxtemplater = (await import('docxtemplater')).default;
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
  });
  doc.render(placeholders);
  const out = doc.getZip().generate({ type: 'nodebuffer' }) as Buffer;
  return { buffer: out, ext: 'docx' };
}

/**
 * Core generation handler. Kept as a separate function so we can return
 * meaningful error responses at every stage without nested try/catch.
 */
async function runGeneration(
  domainId: string,
  caseId: string,
  templateId: string,
  userInstructions: string | undefined,
  actorUserId: string,
  selectedDocIds: string[] | null
): Promise<
  | { ok: true; generationId: string; outputPath: string; tokens: number }
  | { ok: false; status: number; error: string; generationId?: string }
> {
  const admin = createAdminClient();

  // 0. Verify case + template belong to this domain + fetch template file
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: tplRow } = await (admin as any)
    .from('domain_template')
    .select('id, domain_id, file_path, file_type, name')
    .eq('id', templateId)
    .eq('domain_id', domainId)
    .maybeSingle();
  if (!tplRow) return { ok: false, status: 404, error: 'Template not found' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: caseRow } = await (admin as any)
    .from('domain_case')
    .select('id')
    .eq('id', caseId)
    .eq('domain_id', domainId)
    .maybeSingle();
  if (!caseRow) return { ok: false, status: 404, error: 'Case not found' };

  // 1. Create generation row in pending status upfront — we update with
  // final status + output_path below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: genRow, error: genErr } = (await (admin as any)
    .from('domain_generation')
    .insert({
      case_id: caseId,
      template_id: templateId,
      status: 'running',
      user_prompt: userInstructions ?? null,
      started_at: new Date().toISOString(),
      requested_by: actorUserId,
    })
    .select('id')
    .single()) as { data: { id: string } | null; error: { message: string } | null };
  if (genErr || !genRow) {
    return { ok: false, status: 500, error: genErr?.message ?? 'Could not create generation' };
  }
  const generationId = genRow.id;

  const fail = async (
    msg: string
  ): Promise<{ ok: false; status: number; error: string; generationId: string }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('domain_generation')
      .update({
        status: 'failed',
        error_message: msg.slice(0, 1000),
        completed_at: new Date().toISOString(),
      })
      .eq('id', generationId);
    return { ok: false, status: 500, error: msg, generationId };
  };

  // 2. Build context (template + training RAG + case docs + entities)
  let context;
  try {
    context = await buildGenerationContext({
      domainId,
      caseId,
      templateId,
      userInstructions,
      selectedDocIds,
    });
  } catch (err) {
    return fail(`Context build failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Audit suspicious case-doc content (BIZZ-734)
  const combinedCaseText = context.case_docs.map((d) => d.text).join('\n\n');
  const suspicious = scanSuspiciousContent(combinedCaseText);
  if (suspicious.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('domain_audit_log').insert({
      domain_id: domainId,
      actor_user_id: actorUserId,
      action: 'suspicious_case_doc_content',
      target_type: 'case_doc',
      target_id: caseId,
      metadata: { patterns: suspicious, generation_id: generationId },
    });
  }

  // 3. Call Claude
  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY;
  if (!apiKey) return fail('BIZZASSIST_CLAUDE_KEY not configured');
  const client = new Anthropic({ apiKey });

  const userPromptParts = [
    `Template: ${context.template.name}`,
    context.template.placeholders.length > 0
      ? `Placeholders to fill: ${JSON.stringify(context.template.placeholders.map((p) => ({ name: p.name, description: p.description, source_hint: p.source_hint })))}`
      : null,
    context.case_docs.length > 0
      ? `Case documents:\n${context.case_docs.map((d) => `=== ${d.name} ===\n${d.text}`).join('\n\n')}`
      : null,
    context.training_chunks.length > 0
      ? `Reference material (training):\n${context.training_chunks.map((c) => c.content).join('\n---\n')}`
      : null,
    context.case_doc_chunks.length > 0
      ? `Relevant case-doc excerpts:\n${context.case_doc_chunks.map((c) => c.content).join('\n---\n')}`
      : null,
    context.bizzassist_data.length > 0
      ? `BizzAssist reference data (CVR / BFE lookups for entities in the case docs):\n${context.bizzassist_data
          .map(
            (e) =>
              `=== ${e.kind.toUpperCase()} ${e.id} ===\n${
                typeof e.data === 'string' ? e.data : JSON.stringify(e.data)
              }`
          )
          .join('\n\n')}`
      : null,
    context.template.examples.length > 0
      ? `Examples:\n${context.template.examples.map((e) => e.text).join('\n---\n')}`
      : null,
    'Respond with valid JSON matching the schema: { placeholders, sections[], unresolved? }',
  ].filter(Boolean);

  let claudeResponse: string;
  let tokensUsed = 0;
  try {
    const resp = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: context.system_prompt,
      messages: [{ role: 'user', content: userPromptParts.join('\n\n') }],
    });
    claudeResponse = resp.content
      .filter((b) => b.type === 'text')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b) => (b as any).text as string)
      .join('');
    tokensUsed = (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);
  } catch (err) {
    return fail(`Claude call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Validate output via strict schema (BIZZ-734)
  const parsed = parseGenerationOutput(claudeResponse);
  if (!parsed.ok) {
    return fail(`Schema validation: ${parsed.error}`);
  }
  const output: GenerationOutput = parsed.data;

  // 5. Fetch template file + fill
  let templateBuffer: Buffer;
  try {
    const { data: file, error: dlErr } = await admin.storage
      .from('domain-files')
      .download(tplRow.file_path);
    if (dlErr || !file) {
      return fail(`Template download failed: ${dlErr?.message ?? 'unknown'}`);
    }
    templateBuffer = Buffer.from(await file.arrayBuffer());
  } catch (err) {
    return fail(`Template fetch: ${err instanceof Error ? err.message : String(err)}`);
  }

  let filled;
  try {
    filled = await fillDocx(templateBuffer, tplRow.file_type, output.placeholders);
  } catch (err) {
    return fail(`Docx fill failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Upload rendered output
  const outputPath = `${domainId}/generated/${generationId}.${filled.ext}`;
  try {
    const { error: upErr } = await admin.storage
      .from('domain-files')
      .upload(outputPath, filled.buffer, {
        contentType:
          filled.ext === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/octet-stream',
        upsert: true,
      });
    if (upErr) return fail(`Upload failed: ${upErr.message}`);
  } catch (err) {
    return fail(`Upload: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7. Finalise domain_generation row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('domain_generation')
    .update({
      status: 'completed',
      output_path: outputPath,
      claude_tokens: tokensUsed,
      completed_at: new Date().toISOString(),
      input_doc_ids: context.case_docs.map((d) => d.id),
    })
    .eq('id', generationId);

  // 8. Token metering — RPC into domain_increment_ai_tokens (migration 059)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).rpc('domain_increment_ai_tokens', {
      p_domain_id: domainId,
      p_tokens: tokensUsed,
    });
  } catch (err) {
    logger.warn('[domain/generate] Token increment failed (non-fatal):', err);
  }

  // 9. Audit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: actorUserId,
    action: 'generate_document',
    target_type: 'generation',
    target_id: generationId,
    metadata: {
      template_id: templateId,
      case_id: caseId,
      tokens: tokensUsed,
      placeholder_count: Object.keys(output.placeholders).length,
      unresolved_count: output.unresolved?.length ?? 0,
      warnings: context.warnings,
      // BIZZ-801: trace the doc-subset that drove this generation
      selected_doc_ids: selectedDocIds,
    },
  });

  return { ok: true, generationId, outputPath, tokens: tokensUsed };
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, caseId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const templateId = typeof body.template_id === 'string' ? body.template_id : '';
  const userInstructions =
    typeof body.user_instructions === 'string' ? body.user_instructions.slice(0, 5000) : undefined;
  // BIZZ-801: Accept optional selected_doc_ids (uuid[] max 50) — when
  // present, the prompt builder filters case_docs to just these.
  const rawSelected = Array.isArray(body.selected_doc_ids) ? body.selected_doc_ids : [];
  const selectedDocIds = rawSelected
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, 50);
  const selectedDocIdsArg = selectedDocIds.length > 0 ? selectedDocIds : null;
  if (!templateId) {
    return NextResponse.json({ error: 'template_id is required' }, { status: 400 });
  }

  // BIZZ-720: domain-level AI gate (monthly token cap). User-level gate is
  // handled separately in aiGate.ts for non-domain routes; domain routes only
  // meter against the domain's budget since the feature is enterprise-plan.
  const domainBlocked = await assertDomainAiAllowed(domainId);
  if (domainBlocked) return domainBlocked as unknown as NextResponse;

  const result = await runGeneration(
    domainId,
    caseId,
    templateId,
    userInstructions,
    ctx.userId,
    selectedDocIdsArg
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, generation_id: result.generationId },
      { status: result.status }
    );
  }
  return NextResponse.json(
    {
      generation_id: result.generationId,
      output_path: result.outputPath,
      tokens: result.tokens,
    },
    { status: 201 }
  );
}
