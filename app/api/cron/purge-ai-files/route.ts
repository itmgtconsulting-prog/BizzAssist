/**
 * Purge AI files cron — hourly cleanup af udløbne AI-attachments og
 * AI-genererede filer.
 *
 * BIZZ-810 (AI DocGen 1/8). Foundation for AI-file-pipeline:
 *   * /api/ai/attach uploader til ai-attachments bucket + skriver ai_file-row
 *   * /api/ai/generate-file producerer output i ai-generated bucket + ai_file-row
 *   * Alle ai_file rækker har expires_at (default 24 timer)
 *   * Denne cron kører hver time, sletter udløbne rækker + tilhørende storage-blobs
 *
 * Security: CRON_SECRET bearer + x-vercel-cron=1 i produktion.
 *
 * Error-handling: storage-delete kan fejle (fx file already gone) — warn-log
 * og fortsæt med næste række, aldrig fail-fast. DB-delete køres kun efter
 * storage-delete forsøg så vi ikke efterlader orphaned blobs.
 *
 * @module api/cron/purge-ai-files
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';

interface ExpiredFile {
  id: string;
  kind: 'attachment' | 'generated';
  file_path: string;
}

/**
 * Verificerer CRON_SECRET bearer + x-vercel-cron header (i produktion).
 * Returnerer true hvis kald er autoriseret.
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/**
 * GET endpoint (Vercel cron bruger GET). Slet alle ai_file-rækker med
 * expires_at < now() + tilhørende storage-blobs.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: expired, error: fetchErr } = await (admin as any)
    .from('ai_file')
    .select('id, kind, file_path')
    .lt('expires_at', nowIso)
    .limit(500); // cap per-run så cron ikke overloader ved backlog

  if (fetchErr) {
    logger.error('[purge-ai-files] fetch fejlede:', fetchErr.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  const rows = (expired ?? []) as ExpiredFile[];
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0 });
  }

  // Group storage-paths by bucket for batch-delete
  const attachmentPaths: string[] = [];
  const generatedPaths: string[] = [];
  const rowIds: string[] = [];
  for (const row of rows) {
    rowIds.push(row.id);
    if (row.kind === 'attachment') attachmentPaths.push(row.file_path);
    else if (row.kind === 'generated') generatedPaths.push(row.file_path);
  }

  // Storage-delete: best-effort. Fejl logges men blokerer ikke DB-cleanup
  // så vi aldrig får orphaned-row hvis blob mangler.
  let storageErrors = 0;
  if (attachmentPaths.length > 0) {
    const { error: err } = await admin.storage.from('ai-attachments').remove(attachmentPaths);
    if (err) {
      logger.warn('[purge-ai-files] ai-attachments delete warning:', err.message);
      storageErrors++;
    }
  }
  if (generatedPaths.length > 0) {
    const { error: err } = await admin.storage.from('ai-generated').remove(generatedPaths);
    if (err) {
      logger.warn('[purge-ai-files] ai-generated delete warning:', err.message);
      storageErrors++;
    }
  }

  // DB-delete — ryd op uanset storage-resultat
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: deleteErr, count } = (await (admin as any)
    .from('ai_file')
    .delete({ count: 'exact' })
    .in('id', rowIds)) as { error: { message: string } | null; count: number | null };

  if (deleteErr) {
    logger.error('[purge-ai-files] db delete fejlede:', deleteErr.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deleted: count ?? rowIds.length,
    storageErrors,
    attachmentsRemoved: attachmentPaths.length,
    generatedRemoved: generatedPaths.length,
  });
}
