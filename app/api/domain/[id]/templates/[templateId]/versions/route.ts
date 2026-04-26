/**
 * Template versions API — list + create new version.
 *
 * BIZZ-710: When an admin re-uploads a template file, create a new
 * domain_template_version row AND promote it to the current version on
 * domain_template (bumps version, updates file_path + placeholders).
 *
 * Purges the oldest version(s) once a template has more than MAX_VERSIONS
 * to keep the audit trail bounded.
 *
 * GET  /api/domain/:id/templates/:tid/versions — list all versions (newest first)
 * POST /api/domain/:id/templates/:tid/versions — upload new version (multipart)
 *
 * @module api/domain/[id]/templates/[templateId]/versions
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember, assertDomainAdmin } from '@/app/lib/domainAuth';
import { uploadDomainFile } from '@/app/lib/domainStorage';
import { extractTextFromBuffer, type DomainFileType } from '@/app/lib/domainTextExtraction';
import { resolveFileType, supportedLabels } from '@/app/lib/domainFileTypes';
import { detectPlaceholders } from '@/app/lib/domainPlaceholderDetect';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string; templateId: string }> };

/** Max versions to keep per template — BIZZ-710 spec. */
const MAX_VERSIONS = 10;

// BIZZ-788: file-type validation centraliseret i app/lib/domainFileTypes.ts.

/** GET — list versions for this template (newest first). */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, templateId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  // Verify template belongs to domain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: tpl } = await (admin as any)
    .from('domain_template')
    .select('id')
    .eq('id', templateId)
    .eq('domain_id', domainId)
    .maybeSingle();
  if (!tpl) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('domain_template_version')
    .select('id, version, file_path, note, created_at, created_by')
    .eq('template_id', templateId)
    .order('version', { ascending: false });

  return NextResponse.json(data ?? []);
}

/**
 * POST — upload a new version. Admin-only.
 * Body: multipart/form-data with { file, note? }
 *
 * Flow:
 *   1. Verify template exists + belongs to domain
 *   2. Upload file to storage (namespaced by domain)
 *   3. Extract text + detect placeholders
 *   4. Insert new domain_template_version row (version = currentMax + 1)
 *   5. Promote to current on domain_template (bump version + update file_path)
 *   6. Purge oldest versions beyond MAX_VERSIONS
 *   7. Audit log
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId, templateId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: tpl } = await (admin as any)
    .from('domain_template')
    .select('id, version')
    .eq('id', templateId)
    .eq('domain_id', domainId)
    .maybeSingle();
  if (!tpl) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }
  const file = formData.get('file');
  const noteInput = formData.get('note');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 });
  }
  const mime = file.type || 'application/octet-stream';
  const fileType = resolveFileType(mime, file.name);
  if (!fileType) {
    return NextResponse.json(
      { error: `Ugyldig filtype: ${mime}. Tilladt: ${supportedLabels()}.` },
      { status: 400 }
    );
  }
  const note = typeof noteInput === 'string' ? noteInput.trim().slice(0, 500) : null;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { path } = await uploadDomainFile(domainId, 'templates', file.name, buffer, mime);

    // Extract + detect
    const extraction = await extractTextFromBuffer(buffer, fileType as DomainFileType);
    const placeholders = extraction.ok ? detectPlaceholders(extraction.text) : [];
    const placeholderPayload = placeholders.map((p) => ({
      name: p.name,
      syntax: p.syntax,
      context: p.context,
      count: p.count,
    }));

    const newVersion = Number((tpl as { version: number }).version) + 1;

    // Insert version row
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: vErr } = await (admin as any).from('domain_template_version').insert({
      template_id: templateId,
      version: newVersion,
      file_path: path,
      placeholders: placeholderPayload,
      created_by: ctx.userId,
      note: note || 'Re-upload',
    });
    if (vErr) {
      logger.error('[domain/templates/versions] Insert error:', vErr.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // Promote on domain_template
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('domain_template')
      .update({
        version: newVersion,
        file_path: path,
        file_type: fileType,
        placeholders: placeholderPayload,
        updated_at: new Date().toISOString(),
      })
      .eq('id', templateId);

    // Purge oldest beyond MAX_VERSIONS
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: allVersions } = await (admin as any)
      .from('domain_template_version')
      .select('id, version, file_path')
      .eq('template_id', templateId)
      .order('version', { ascending: false });
    const rows = (allVersions ?? []) as Array<{ id: string; version: number; file_path: string }>;
    if (rows.length > MAX_VERSIONS) {
      const toPurge = rows.slice(MAX_VERSIONS);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from('domain_template_version')
        .delete()
        .in(
          'id',
          toPurge.map((r) => r.id)
        );
      try {
        await admin.storage.from('domain-files').remove(toPurge.map((r) => r.file_path));
      } catch (err) {
        logger.warn('[domain/templates/versions] Storage purge failed (non-fatal):', err);
      }
    }

    // Audit
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('domain_audit_log').insert({
      domain_id: domainId,
      actor_user_id: ctx.userId,
      action: 'new_template_version',
      target_type: 'template',
      target_id: templateId,
      metadata: {
        version: newVersion,
        placeholder_count: placeholders.length,
        purged: Math.max(0, rows.length + 1 - MAX_VERSIONS),
      },
    });

    return NextResponse.json(
      {
        ok: true,
        version: newVersion,
        placeholder_count: placeholders.length,
      },
      { status: 201 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    logger.error('[domain/templates/versions] Upload error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
