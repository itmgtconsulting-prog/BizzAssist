/**
 * POST /api/knowledge/upload — upload a file and save its text to the tenant knowledge base.
 *
 * Auth: tenant_admin role required.
 * Body: multipart/form-data with a single `file` field.
 *
 * Supported MIME types:
 *  - text/plain                                          — read UTF-8 directly
 *  - application/pdf                                     — extract text layer via pdf-parse
 *  - application/vnd.openxmlformats-officedocument.wordprocessingml.document (DOCX)
 *                                                        — extract text from XML parts using JSZip
 *
 * Max file size: 1 MB (1 048 576 bytes).
 * Max extracted content: 50 000 characters (mirrors tenant_knowledge CHECK constraint).
 *
 * Returns: { id, title: filename, charCount }
 *
 * Retention: rows carry tenant_id + created_by for cascade delete on offboarding.
 * GDPR: no PII stored beyond what the admin deliberately uploads.
 *
 * @module api/knowledge/upload
 */

import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
/** Maximum allowed upload size in bytes (1 MiB). */
const MAX_FILE_BYTES = 1_048_576;

/** Maximum characters stored in tenant_knowledge.content. */
const MAX_CONTENT_CHARS = 50_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves the authenticated user's tenant_id and role.
 *
 * Also resolves the physical schema name (e.g. `tenant_abc123`) for the
 * per-tenant tenant_knowledge table (BIZZ-2277) — the PostgREST `.schema()`
 * API needs the schema name, not the tenant UUID.
 *
 * @param userId - Supabase Auth user UUID
 * @returns { tenantId, role, schemaName } or null if no membership found
 */
async function resolveTenantMembership(
  userId: string
): Promise<{ tenantId: string; role: string; schemaName: string } | null> {
  const adminClient = createAdminClient();
  const { data } = await adminClient
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('user_id', userId)
    .limit(1)
    .single();
  if (!data?.tenant_id) return null;

  const { data: tenant } = await adminClient
    .from('tenants')
    .select('schema_name')
    .eq('id', data.tenant_id)
    .single();
  if (!tenant?.schema_name) return null;

  return {
    tenantId: data.tenant_id as string,
    role: data.role as string,
    schemaName: tenant.schema_name as string,
  };
}

/**
 * Extracts human-readable text from a plain-text buffer.
 * Assumes UTF-8 encoding.
 *
 * @param buf - Raw file buffer
 * @returns Extracted text string
 */
function extractTxt(buf: Buffer): string {
  return buf.toString('utf-8');
}

/**
 * Extracts the text layer from a PDF buffer using the `pdf-parse` library
 * (a proper PDF parser, already declared in next.config serverExternalPackages).
 *
 * This replaces the previous regex byte-scan heuristic (BIZZ-2281): pdf-parse
 * decodes the content streams correctly, so multi-line text, word spacing and
 * encodings survive instead of being reconstructed by pattern-matching.
 *
 * Loaded via dynamic import so the (heavy) parser is only pulled in when a PDF
 * is actually uploaded. Image-only/scanned PDFs yield empty text — the caller
 * then returns a 422 "no searchable text" message. A parse failure is caught
 * and downgraded to empty text (never a 500) so a single malformed file cannot
 * crash the request.
 *
 * @param buf - Raw PDF file buffer
 * @returns Extracted plain text (empty string if the PDF has no text layer)
 */
async function extractPdf(buf: Buffer): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const result = await parser.getText();
    return (
      (result.text ?? '')
        // pdf-parse appends "-- N of M --" page separators — strip them.
        .replace(/^-- \d+ of \d+ --$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  } catch (err) {
    logger.error('[knowledge/upload] pdf-parse fejlede:', err);
    return '';
  }
}

/**
 * Extracts plain text from a DOCX file using JSZip to unpack the ZIP archive
 * and strip XML tags from word/document.xml.
 *
 * @param buf - Raw DOCX file buffer
 * @returns Extracted text string
 */
async function extractDocx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const documentXmlFile = zip.file('word/document.xml');
  if (!documentXmlFile) {
    return '';
  }
  const xmlText = await documentXmlFile.async('string');
  // Replace paragraph and run breaks with newlines, then strip all XML tags
  const text = xmlText
    .replace(/<w:p[ >]/g, '\n<w:p>')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

// ─── POST /api/knowledge/upload ───────────────────────────────────────────────

/**
 * Handles multipart file upload, extracts text, and saves it as a knowledge item.
 *
 * @param request - Incoming Next.js request with multipart/form-data body
 * @returns JSON { id, title, charCount } on success
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as unknown as NextResponse;

  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await resolveTenantMembership(user.id);
  if (!membership) {
    return NextResponse.json({ error: 'Ingen tenant-tilknytning fundet' }, { status: 403 });
  }
  if (membership.role !== 'tenant_admin') {
    return NextResponse.json(
      { error: 'Kun tenant-administratorer kan uploade filer til videnbasen' },
      { status: 403 }
    );
  }

  // ── Parse multipart form ─────────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Ugyldig multipart/form-data' }, { status: 400 });
  }

  const fileEntry = formData.get('file');
  if (!fileEntry || typeof fileEntry === 'string') {
    return NextResponse.json(
      { error: 'Intet fil-felt fundet (forventet "file")' },
      { status: 400 }
    );
  }
  const file = fileEntry as File;

  // ── Size guard ───────────────────────────────────────────────────────────────
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `Filen er for stor. Maks filstørrelse er 1 MB (${file.size} bytes modtaget).` },
      { status: 413 }
    );
  }

  // ── MIME type check ──────────────────────────────────────────────────────────
  const mime = file.type.toLowerCase();
  const filename = file.name ?? 'uploaded-file';

  const isTxt =
    mime === 'text/plain' || mime === 'text/csv' || (!mime && filename.endsWith('.txt'));
  const isPdf = mime === 'application/pdf' || (!mime && filename.toLowerCase().endsWith('.pdf'));
  const isDocx =
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    (!mime && filename.toLowerCase().endsWith('.docx'));

  if (!isTxt && !isPdf && !isDocx) {
    return NextResponse.json(
      {
        error:
          'Ikke-understøttet filtype. Understøttede typer: PDF (.pdf), Tekst (.txt), Word (.docx).',
      },
      { status: 415 }
    );
  }

  // ── Extract text ─────────────────────────────────────────────────────────────
  let extracted: string;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    if (isTxt) {
      extracted = extractTxt(buf);
    } else if (isPdf) {
      extracted = await extractPdf(buf);
    } else {
      // DOCX
      extracted = await extractDocx(buf);
    }
  } catch (err) {
    logger.error('[knowledge/upload] Tekstudtræk fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // Sanitise whitespace and enforce length cap
  const content = extracted
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CONTENT_CHARS);

  if (content.length === 0) {
    return NextResponse.json(
      { error: 'Ingen tekst fundet i filen. Kontrollér at filen indeholder søgbar tekst.' },
      { status: 422 }
    );
  }

  // Title = filename without extension, max 200 chars
  const title = filename.replace(/\.[^.]+$/, '').slice(0, 200) || 'Upload';

  // ── Persist ──────────────────────────────────────────────────────────────────
  try {
    const { data, error } = await tenantDb(membership.schemaName)
      .from('tenant_knowledge')
      .insert({
        tenant_id: membership.tenantId,
        title,
        content,
        source_type: 'upload',
        created_by: user.id,
      })
      .select('id, title, content, source_type, created_by, created_at, updated_at')
      .single();

    if (error) throw error;

    // Audit log — fire-and-forget (ISO 27001 A.12.4)
    if (data) {
      void createAdminClient()
        .from('audit_log')
        .insert({
          action: 'knowledge.upload',
          resource_type: 'knowledge_item',
          resource_id: String(data.id),
          metadata: JSON.stringify({
            tenantId: membership.tenantId,
            title,
            charCount: content.length,
            userId: user.id,
          }),
        });
    }

    return NextResponse.json(
      {
        id: data?.id,
        title: data?.title ?? title,
        charCount: content.length,
      },
      { status: 201 }
    );
  } catch (err) {
    logger.error('[knowledge/upload] DB-indsættelse fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
