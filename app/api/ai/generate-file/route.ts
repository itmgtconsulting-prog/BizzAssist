/**
 * POST /api/ai/generate-file
 *
 * BIZZ-813 (AI DocGen 4/8): endpoint der producerer en downloadbar fil
 * (XLSX/CSV/DOCX) ud fra struktureret input eller ved at fylde en
 * uploaded template. Kaldes via Claude tool `generate_document` i
 * /api/ai/chat + kan også kaldes direkte fra klient (fx preview-flow).
 *
 * Modes i iter 1:
 *   * scratch — generér fra scratch med aiFileGeneration-lib (BIZZ-811)
 *   * attached_template — fyld en tidligere uploaded DOCX-template
 *     (XLSX-fill er iter 2 via fillXlsxTemplate)
 *   * domain_template — parkeret til BIZZ-816 (kræver proxy til
 *     /api/domain/[id]/case/[caseId]/generate)
 *
 * Returnerer signed download URL (24t) + preview-tekst så klient kan
 * vise chip uden separat fetch-roundtrip.
 *
 * Security: resolveTenantId gated, aiRateLimit, sanitizeFilename,
 * zod-input-validation, ai_file-row med ON DELETE CASCADE fra user.
 *
 * @module api/ai/generate-file
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  generateXlsx,
  generateCsv,
  generateDocx,
  generatePptx,
  fillDocxTemplate,
  xlsxToPreviewTable,
  csvToPreviewTable,
  docxToPreviewHtml,
  GenerateXlsxInputSchema,
  GenerateCsvInputSchema,
  GenerateDocxInputSchema,
  GeneratePptxInputSchema,
  sanitizeFilename,
  type GeneratedFile,
} from '@/app/lib/aiFileGeneration';

// ─── Input schemas ──────────────────────────────────────────────────────

const FormatSchema = z.enum(['xlsx', 'csv', 'docx', 'pptx']);
const ModeSchema = z.enum(['scratch', 'attached_template', 'domain_template']);

const ScratchInputSchema = z
  .object({
    // Inlines relevante felter fra generators. Tool-dispatcher validerer
    // format-specifikt nedenfor.
    columns: z.array(z.object({ key: z.string(), header: z.string() })).optional(),
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
    sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
    subtitle: z.string().optional(),
    sheetName: z.string().optional(),
    // BIZZ-935: PPTX slides input
    slides: z
      .array(
        z.object({
          title: z.string(),
          bullets: z.array(z.string()).optional(),
          table: z
            .object({
              columns: z.array(z.string()),
              rows: z.array(z.array(z.string())),
            })
            .optional(),
        })
      )
      .optional(),
  })
  .optional();

const AttachedTemplateSchema = z
  .object({
    file_id: z.string().uuid(),
    placeholders: z.record(z.string(), z.string()).optional(),
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .optional();

const DomainTemplateSchema = z
  .object({
    domain_id: z.string().uuid(),
    domain_template_id: z.string().uuid(),
    case_id: z.string().uuid(),
    user_instructions: z.string().optional(),
  })
  .optional();

const RequestBodySchema = z.object({
  format: FormatSchema,
  mode: ModeSchema,
  title: z.string().min(1).max(100),
  conv_id: z.string().optional(),
  scratch: ScratchInputSchema,
  attached_template: AttachedTemplateSchema,
  domain_template: DomainTemplateSchema,
  previous_file_id: z.string().uuid().optional(),
});

type RequestBody = z.infer<typeof RequestBodySchema>;

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Hent binær fra ai-attachments bucket for et givet ai_file.id.
 * Returnerer null hvis row ikke findes, tilhører anden user, eller
 * blob mangler. Caller fremsender 404/403 til AI.
 */
async function fetchAttachmentBuffer(
  admin: ReturnType<typeof createAdminClient>,
  fileId: string,
  userId: string
): Promise<{ buffer: Buffer; name: string; file_type: string } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: rowErr } = await (admin as any)
    .from('ai_file')
    .select('user_id, kind, file_path, file_name, file_type')
    .eq('id', fileId)
    .maybeSingle();
  if (rowErr || !row) {
    logger.warn('[generate-file] ai_file row mangler:', fileId, rowErr?.message);
    return null;
  }
  if (row.user_id !== userId) {
    logger.warn('[generate-file] file_id tilhører anden user, afvist');
    return null;
  }
  const bucket = row.kind === 'attachment' ? 'ai-attachments' : 'ai-generated';
  const { data: blob, error: dlErr } = await admin.storage.from(bucket).download(row.file_path);
  if (dlErr || !blob) {
    logger.warn('[generate-file] storage download fejl:', dlErr?.message);
    return null;
  }
  const arrayBuf = await blob.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuf),
    name: row.file_name as string,
    file_type: row.file_type as string,
  };
}

/**
 * Byg preview-tekst til respons. For XLSX/DOCX er dette kort status-
 * tekst; rigtig preview-render kommer i BIZZ-815.
 */
function buildPreviewText(format: string, title: string, sizeBytes: number): string {
  const kb = (sizeBytes / 1024).toFixed(1);
  return `${format.toUpperCase()}-fil "${title}" genereret (${kb} KB).`;
}

// ─── Route handler ──────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rlResp = await checkRateLimit(request, aiRateLimit);
  if (rlResp) return rlResp;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const parsed = RequestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Input-valideringsfejl', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const body: RequestBody = parsed.data;

  /**
   * BIZZ-862: Claude leverer nogle gange nested objects/arrays som row-værdier
   * (fx {ejer: {navn: "Jakob"}}). GenerateXlsxInputSchema kræver primitives,
   * så zod-validation fejlede med "XLSX-schema fejl" og AI viste "teknisk fejl".
   * Løsning: coerce nested values til JSON-strings før validation.
   */
  function coerceRowsForCells(
    rows: Array<Record<string, unknown>> | undefined
  ): Array<Record<string, string | number | boolean | null>> {
    return (rows ?? []).map((row) => {
      const out: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(row)) {
        if (v === null || v === undefined) {
          out[k] = null;
        } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          out[k] = v;
        } else if (v instanceof Date) {
          out[k] = v.toISOString();
        } else {
          try {
            out[k] = JSON.stringify(v);
          } catch {
            out[k] = String(v);
          }
        }
      }
      return out;
    });
  }

  let generated: GeneratedFile;
  try {
    if (body.mode === 'scratch') {
      // ─── mode: scratch ──────────────────────────────────────
      if (body.format === 'xlsx') {
        const v = GenerateXlsxInputSchema.safeParse({
          title: body.title,
          columns: body.scratch?.columns ?? [],
          rows: coerceRowsForCells(body.scratch?.rows),
          sheetName: body.scratch?.sheetName,
        });
        if (!v.success) {
          logger.warn('[generate-file] XLSX-schema fejl:', JSON.stringify(v.error.issues));
          return NextResponse.json(
            { error: 'XLSX-schema fejl', details: v.error.issues },
            { status: 400 }
          );
        }
        generated = await generateXlsx(v.data);
      } else if (body.format === 'csv') {
        const v = GenerateCsvInputSchema.safeParse({
          columns: body.scratch?.columns ?? [],
          rows: coerceRowsForCells(body.scratch?.rows),
        });
        if (!v.success) {
          logger.warn('[generate-file] CSV-schema fejl:', JSON.stringify(v.error.issues));
          return NextResponse.json(
            { error: 'CSV-schema fejl', details: v.error.issues },
            { status: 400 }
          );
        }
        generated = generateCsv(v.data);
      } else if (body.format === 'pptx') {
        // BIZZ-935: PowerPoint-generering
        const v = GeneratePptxInputSchema.safeParse({
          title: body.title,
          slides: body.scratch?.slides ?? [],
        });
        if (!v.success) {
          logger.warn('[generate-file] PPTX-schema fejl:', JSON.stringify(v.error.issues));
          return NextResponse.json(
            { error: 'PPTX-schema fejl', details: v.error.issues },
            { status: 400 }
          );
        }
        generated = await generatePptx(v.data);
      } else {
        // docx
        const v = GenerateDocxInputSchema.safeParse({
          title: body.title,
          subtitle: body.scratch?.subtitle,
          sections: body.scratch?.sections ?? [],
        });
        if (!v.success) {
          return NextResponse.json(
            { error: 'DOCX-schema fejl', details: v.error.issues },
            { status: 400 }
          );
        }
        generated = await generateDocx(v.data);
      }
    } else if (body.mode === 'attached_template') {
      // ─── mode: attached_template (DOCX only i iter 1) ───────
      if (!body.attached_template) {
        return NextResponse.json({ error: 'attached_template input mangler' }, { status: 400 });
      }
      if (body.format !== 'docx') {
        return NextResponse.json(
          {
            error:
              'attached_template understøtter kun docx i iter 1. XLSX-template-fill kommer i BIZZ-813b.',
          },
          { status: 400 }
        );
      }
      const admin = createAdminClient();
      const tmpl = await fetchAttachmentBuffer(admin, body.attached_template.file_id, auth.userId);
      if (!tmpl) {
        return NextResponse.json(
          { error: 'Template ikke fundet eller ingen adgang' },
          { status: 404 }
        );
      }
      if (tmpl.file_type !== 'docx') {
        return NextResponse.json(
          { error: `Template-type ${tmpl.file_type} kan ikke fylles i iter 1 (kun docx)` },
          { status: 400 }
        );
      }
      generated = await fillDocxTemplate(tmpl.buffer, body.attached_template.placeholders ?? {});
    } else {
      // ─── mode: domain_template (BIZZ-816) ───────────────────
      // Proxy til /api/domain/[id]/case/[caseId]/generate som kører
      // Claude-baseret placeholder-fill. Derefter downloader vi output
      // fra domain-files og re-uploader til ai-generated så klienten
      // bruger samme signed-URL-flow som scratch + attached_template.
      if (!body.domain_template) {
        return NextResponse.json({ error: 'domain_template input mangler' }, { status: 400 });
      }
      const admin = createAdminClient();
      const host = request.headers.get('host');
      const proto = request.headers.get('x-forwarded-proto') ?? 'http';
      const base = `${proto}://${host}`;
      const cookieHeader = request.headers.get('cookie') ?? '';
      const genRes = await fetch(
        `${base}/api/domain/${body.domain_template.domain_id}/case/${body.domain_template.case_id}/generate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          body: JSON.stringify({
            template_id: body.domain_template.domain_template_id,
            user_instructions: body.domain_template.user_instructions,
          }),
          signal: AbortSignal.timeout(60_000),
        }
      );
      if (!genRes.ok) {
        const errJson = (await genRes.json().catch(() => ({}))) as { error?: string };
        return NextResponse.json(
          {
            error: errJson.error ?? `domain_template generation fejl (${genRes.status})`,
          },
          { status: genRes.status }
        );
      }
      const genJson = (await genRes.json()) as {
        generation_id: string;
        output_path: string;
        tokens?: number;
      };
      // Download udfyldt output fra domain-files → re-upload til
      // ai-generated så vores TTL-model gælder.
      const { data: blob, error: dlErr } = await admin.storage
        .from('domain-files')
        .download(genJson.output_path);
      if (dlErr || !blob) {
        return NextResponse.json(
          { error: `Kunne ikke hente genereret dokument: ${dlErr?.message ?? 'missing'}` },
          { status: 500 }
        );
      }
      // Udled ext fra output_path (fx "xxx.docx")
      const extMatch = genJson.output_path.match(/\.([a-z0-9]+)$/i);
      const derivedExt = (extMatch?.[1]?.toLowerCase() ?? 'docx') as 'xlsx' | 'csv' | 'docx';
      const contentType =
        derivedExt === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : derivedExt === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : derivedExt === 'csv'
              ? 'text/csv; charset=utf-8'
              : 'application/octet-stream';
      const arrayBuf = await blob.arrayBuffer();
      generated = {
        buffer: Buffer.from(arrayBuf),
        ext: derivedExt,
        contentType,
      };
    }
  } catch (err) {
    logger.error('[generate-file] generator-fejl:', err);
    return NextResponse.json({ error: 'Kunne ikke generere fil' }, { status: 500 });
  }

  // ─── Upload + ai_file tracking ──────────────────────────────
  const admin = createAdminClient();
  const safeTitle = sanitizeFilename(body.title);
  const storagePath = `${auth.userId}/${randomUUID()}-${safeTitle}.${generated.ext}`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // BIZZ-886: Storage-upload med retry (1 forsøg mere ved transient fejl)
  // og mere specifik fejl-besked. Upload-fejl skelnes nu fra size/permission/
  // mime-type fejl så brugeren kan forstå årsagen.
  const uploadWithRetry = async (): Promise<{ error: { message: string } | null }> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await admin.storage
        .from('ai-generated')
        .upload(storagePath, generated.buffer, {
          contentType: generated.contentType,
          upsert: false,
        });
      if (!error) return { error: null };
      // Retry kun ved transient fejl (5xx, timeout). 4xx (permission/size) er
      // ikke retry-bart — fejl igen med samme resultat.
      const msg = (error.message || '').toLowerCase();
      const transient = msg.includes('timeout') || msg.includes('network') || msg.includes('5');
      if (!transient || attempt === 1) return { error };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { error: null };
  };

  const { error: uploadErr } = await uploadWithRetry();
  if (uploadErr) {
    logger.error('[generate-file] upload fejl:', uploadErr.message);
    const rawMsg = (uploadErr.message || '').toLowerCase();
    let userMsg = 'Storage upload fejlede';
    if (rawMsg.includes('size') || rawMsg.includes('too large')) {
      userMsg = `Fil for stor — maks 10 MB (${(generated.buffer.length / 1024 / 1024).toFixed(1)} MB)`;
    } else if (rawMsg.includes('mime') || rawMsg.includes('type')) {
      userMsg = `Fil-format ikke tilladt (${generated.contentType})`;
    } else if (
      rawMsg.includes('permission') ||
      rawMsg.includes('denied') ||
      rawMsg.includes('403')
    ) {
      userMsg = 'Storage-tilladelser mangler — kontakt support';
    } else if (rawMsg.includes('timeout') || rawMsg.includes('network')) {
      userMsg = 'Storage-netværksfejl — prøv igen om et øjeblik';
    }
    return NextResponse.json({ error: userMsg }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: insertErr } = await (admin as any)
    .from('ai_file')
    .insert({
      user_id: auth.userId,
      kind: 'generated',
      conv_id: body.conv_id ?? null,
      file_path: storagePath,
      file_name: `${safeTitle}.${generated.ext}`,
      file_type: generated.ext,
      size_bytes: generated.buffer.length,
      metadata: {
        source_mode: body.mode,
        previous_file_id: body.previous_file_id ?? null,
        format: body.format,
      },
      expires_at: expiresAt,
    })
    .select('id, file_name')
    .single();
  if (insertErr || !row) {
    logger.error('[generate-file] ai_file insert fejl:', insertErr?.message);
    // Ryd blob op så vi ikke efterlader orphan
    await admin.storage
      .from('ai-generated')
      .remove([storagePath])
      .catch(() => null);
    return NextResponse.json({ error: 'Tracking-row kunne ikke oprettes' }, { status: 500 });
  }

  // Signed download URL (24t matcher TTL)
  const { data: signedData, error: signedErr } = await admin.storage
    .from('ai-generated')
    .createSignedUrl(storagePath, 60 * 60 * 24);
  if (signedErr || !signedData?.signedUrl) {
    logger.error('[generate-file] signed URL fejl:', signedErr?.message);
    return NextResponse.json({ error: 'Signed URL kunne ikke oprettes' }, { status: 500 });
  }

  // BIZZ-815: binary-aware preview. For XLSX/CSV bygger vi table-preview
  // som klienten kan rendere direkte (sticky header + zebra rows).
  // BIZZ-868: DOCX faar nu html-preview via mammoth (inline tekst + basic formatering).
  let previewKind: 'text' | 'table' | 'html' = 'text';
  let previewColumns: string[] | undefined;
  let previewRows: string[][] | undefined;
  let previewHtml: string | undefined;
  try {
    if (body.format === 'xlsx') {
      const tbl = await xlsxToPreviewTable(generated.buffer);
      if (tbl.columns.length > 0) {
        previewKind = 'table';
        previewColumns = tbl.columns;
        previewRows = tbl.rows;
      }
    } else if (body.format === 'csv') {
      const tbl = csvToPreviewTable(generated.buffer);
      if (tbl.columns.length > 0) {
        previewKind = 'table';
        previewColumns = tbl.columns;
        previewRows = tbl.rows;
      }
    } else if (body.format === 'docx') {
      const parsed = await docxToPreviewHtml(generated.buffer);
      if (parsed.html.length > 0) {
        previewKind = 'html';
        previewHtml = parsed.html;
      }
    }
  } catch (previewErr) {
    // Preview-parsing er best-effort — hvis det fejler falder vi tilbage til text
    logger.warn('[generate-file] preview-parse fejl (non-fatal):', previewErr);
  }

  return NextResponse.json({
    file_id: row.id as string,
    file_name: row.file_name as string,
    download_url: signedData.signedUrl,
    preview_text: buildPreviewText(body.format, safeTitle, generated.buffer.length),
    preview_kind: previewKind,
    preview_columns: previewColumns,
    preview_rows: previewRows,
    preview_html: previewHtml,
    bytes: generated.buffer.length,
    format: body.format,
  });
}
