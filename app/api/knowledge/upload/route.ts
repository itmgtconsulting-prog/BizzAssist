/**
 * POST /api/knowledge/upload — upload a file and save its text to the tenant knowledge base.
 *
 * Auth: tenant_admin role required.
 * Body: multipart/form-data with a single `file` field.
 *
 * Supported MIME types:
 *  - text/plain                                          — read UTF-8 directly
 *  - application/pdf                                     — extract printable ASCII text from buffer
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
/** Maximum allowed upload size in bytes (1 MiB). */
const MAX_FILE_BYTES = 1_048_576;

/** Maximum characters stored in tenant_knowledge.content. */
const MAX_CONTENT_CHARS = 50_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves the authenticated user's tenant_id and role.
 *
 * @param userId - Supabase Auth user UUID
 * @returns { tenantId, role } or null if no membership found
 */
async function resolveTenantMembership(
  userId: string
): Promise<{ tenantId: string; role: string } | null> {
  const adminClient = createAdminClient();
  const { data } = await adminClient
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('user_id', userId)
    .limit(1)
    .single();
  if (!data?.tenant_id) return null;
  return { tenantId: data.tenant_id as string, role: data.role as string };
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
 * Extracts printable text from a PDF buffer using a simple byte-scan approach.
 *
 * This does NOT use a full PDF parser — it scans for runs of printable ASCII
 * characters inside the raw PDF stream data. Accuracy is lower than a proper
 * parser but requires no additional dependencies and handles the common case
 * of text-layer PDFs well enough for a knowledge-base upload feature.
 *
 * If pdfjs-dist is added in the future, replace this implementation.
 *
 * @param buf - Raw PDF file buffer
 * @returns Extracted text (may include some noise from PDF structure tokens)
 */
function extractPdf(buf: Buffer): string {
  // Decode the PDF bytes and scan for BT...ET (Begin Text...End Text) blocks.
  // Inside those blocks, extract string literals surrounded by () or <>.
  const raw = buf.toString('latin1');
  const parts: string[] = [];

  // Match PDF string literals inside text blocks: (some text) or <hex>
  const btEtPattern = /BT([\s\S]*?)ET/g;
  let btMatch: RegExpExecArray | null;

  while ((btMatch = btEtPattern.exec(raw)) !== null) {
    const block = btMatch[1];
    // Extract literal strings: (...)
    const litPattern = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let litMatch: RegExpExecArray | null;
    while ((litMatch = litPattern.exec(block)) !== null) {
      // Unescape basic PDF escape sequences
      const text = litMatch[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')');
      // Only keep runs with at least 2 printable characters
      if (/[\x20-\x7E]{2,}/.test(text)) {
        parts.push(text);
      }
    }
  }

  if (parts.length > 0) {
    return parts
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // Fallback: extract all printable ASCII runs ≥ 4 chars from the raw bytes.
  const fallbackParts: string[] = [];
  const runPattern = /[\x20-\x7E]{4,}/g;
  let runMatch: RegExpExecArray | null;
  while ((runMatch = runPattern.exec(raw)) !== null) {
    const run = runMatch[0].trim();
    // Skip PDF structure tokens that are clearly not human text
    if (/^(obj|endobj|stream|endstream|xref|trailer|startxref|<<|>>|\d+ \d+ R)$/.test(run)) {
      continue;
    }
    if (run.length >= 4) fallbackParts.push(run);
  }
  return fallbackParts
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
      extracted = extractPdf(buf);
    } else {
      // DOCX
      extracted = await extractDocx(buf);
    }
  } catch (err) {
    console.error('[knowledge/upload] Tekstudtræk fejlede:', err);
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
    const { data, error } = await tenantDb(membership.tenantId)
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
    console.error('[knowledge/upload] DB-indsættelse fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
