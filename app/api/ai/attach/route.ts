/**
 * POST /api/ai/attach
 *
 * Lightweight attachment-extraction endpoint used by the global AI Chat.
 * The user picks one or more files in the chat input; each file is POSTed
 * here, text is extracted via the same pipeline used for domain case-docs,
 * and a preview + full text is returned to the client.
 *
 * The attachment is NOT persisted server-side — the client holds the
 * extracted text in state and prepends it to the next user message so
 * Claude gets the content as context. This keeps attachments scoped to
 * the current chat turn and avoids creating orphan storage blobs.
 *
 * BIZZ-806: Backing endpoint for AIChatPanel paperclip + preview-chip UX.
 *
 * @module api/ai/attach
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { extractTextFromBuffer } from '@/app/lib/domainTextExtraction';
import { resolveFileType, supportedLabels } from '@/app/lib/domainFileTypes';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import { sanitizeFilename } from '@/app/lib/aiFileGeneration';

/** 20 MB cap on any single attachment — keeps extraction snappy and bounds
 * how much context can be shoved into a single chat turn. */
const MAX_BYTES = 20 * 1024 * 1024;

/** Chars returned in the `preview` field — enough to render a ~10-line
 * block in a chip/modal without dumping the whole doc into the response. */
const PREVIEW_CHARS = 600;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Auth + per-user rate limit on AI-adjacent calls.
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rlResp = await checkRateLimit(request, aiRateLimit);
  if (rlResp) return rlResp;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Filen er for stor (max ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 413 }
    );
  }

  const mime = file.type || 'application/octet-stream';
  const fileType = resolveFileType(mime, file.name);
  if (!fileType) {
    return NextResponse.json(
      { error: `Ugyldig filtype. Tilladt: ${supportedLabels()}.` },
      { status: 400 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await extractTextFromBuffer(buffer, fileType);
    if (!result.ok) {
      return NextResponse.json(
        { error: `Kunne ikke læse indholdet: ${result.error}` },
        { status: 422 }
      );
    }
    const full = result.text;
    const preview = full.slice(0, PREVIEW_CHARS) + (full.length > PREVIEW_CHARS ? '…' : '');

    // BIZZ-812: persist binary + ai_file metadata så efterfølgende
    // tool-call (BIZZ-813 generate_document) kan fill template'et.
    // Best-effort: hvis upload/DB-insert fejler, loger vi men fortsætter
    // med status quo (kun tekst-injection) så chat-flow ikke blokeres.
    const safeName = sanitizeFilename(file.name);
    const storagePath = `${auth.userId}/${randomUUID()}-${safeName}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    let fileId: string | null = null;
    try {
      const admin = createAdminClient();
      const { error: uploadErr } = await admin.storage
        .from('ai-attachments')
        .upload(storagePath, buffer, {
          contentType: mime,
          upsert: false,
        });
      if (uploadErr) {
        logger.warn('[ai/attach] storage upload fejl:', uploadErr.message);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: row, error: insertErr } = await (admin as any)
          .from('ai_file')
          .insert({
            user_id: auth.userId,
            kind: 'attachment',
            file_path: storagePath,
            file_name: safeName,
            file_type: fileType,
            size_bytes: file.size,
            metadata: { mime, truncated: result.truncated ?? false },
            expires_at: expiresAt,
          })
          .select('id')
          .single();
        if (insertErr || !row) {
          logger.warn('[ai/attach] ai_file insert fejl:', insertErr?.message ?? 'no row returned');
          // Ryd storage-blob op så vi ikke efterlader orphan
          await admin.storage
            .from('ai-attachments')
            .remove([storagePath])
            .catch(() => null);
        } else {
          fileId = row.id as string;
        }
      }
    } catch (persistErr) {
      logger.warn('[ai/attach] persistens-fejl:', persistErr);
    }

    return NextResponse.json({
      // BIZZ-812: file_id er null hvis persistens fejlede — klienten
      // behandler det som "kun tekst-injection" fallback.
      file_id: fileId,
      name: file.name,
      file_type: fileType,
      size: file.size,
      extracted_text: full,
      preview,
      truncated: result.truncated,
    });
  } catch (err) {
    logger.warn('[ai/attach] unexpected extraction error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
