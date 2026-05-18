/**
 * POST /api/vurderingsrapport/sager/[sagId]/upload
 *
 * BIZZ-1642: Upload dokument til en upload-zone, parse via Claude,
 * og gem parsed_data i vurdering_dokumenter.
 *
 * Body: multipart/form-data med 'file' + 'zone_type'
 *
 * @module api/vurderingsrapport/sager/[sagId]/upload
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { logger } from '@/app/lib/logger';
import { sanitizeFilename } from '@/app/lib/aiFileGeneration';
import { resolveFileType } from '@/app/lib/domainFileTypes';
import { extractTextFromBuffer } from '@/app/lib/domainTextExtraction';

export const maxDuration = 120;

const BUCKET = 'forsikring-documents'; // Reuse existing bucket
const MAX_BYTES = 20 * 1024 * 1024;

/** Zone-specifikke system-prompts for Claude parsing */
const ZONE_PROMPTS: Record<string, string> = {
  lejeindtaegter: `Du er en ejendomsvurderingsekspert. Udtrk lejeindtgter fra dette dokument.
Returner JSON: { "lejeindtaegter": [{ "type": string, "areal_kvm": number, "antal": number, "faktisk_leje": number, "maks_leje": number|null }] }
Returner KUN JSON, ingen forklaring.`,

  driftsudgifter: `Du er en ejendomsvurderingsekspert. Udtrk driftsudgifter fra dette dokument.
Returner JSON: { "driftsudgifter": [{ "post": string, "beloeb": number }] }
Returner KUN JSON, ingen forklaring.`,

  besigtigelse: `Du er en ejendomsvurderingsekspert. Udtrk besigtigelsesobservationer fra dette dokument.
Returner JSON: { "stand": string, "observationer": [string], "vedligeholdsbehov": [string] }
Returner KUN JSON, ingen forklaring.`,

  referenceejendomme: `Du er en ejendomsvurderingsekspert. Udtrk referenceejendomme fra dette dokument.
Returner JSON: { "referencer": [{ "adresse": string, "type": string, "areal_kvm": number, "leje_kvm": number|null, "kommentar": string|null }] }
Returner KUN JSON, ingen forklaring.`,

  oevrige: `Du er en ejendomsvurderingsekspert. Udtrk nglefakta fra dette dokument.
Returner JSON: { "noeglefakta": [string], "kontekst": string }
Returner KUN JSON, ingen forklaring.`,
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sagId: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  const { sagId } = await params;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('file');
  const zoneType = formData.get('zone_type') as string | null;
  if (!(file instanceof File) || !zoneType) {
    return NextResponse.json({ error: 'file og zone_type påkrævet' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Fil for stor (max 20 MB)' }, { status: 413 });
  }

  const mime = file.type || 'application/octet-stream';
  const fileType = resolveFileType(mime, file.name);
  if (!fileType) {
    return NextResponse.json({ error: 'Ugyldig filtype' }, { status: 400 });
  }

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Ensure zone exists (upsert)
    const { data: zone } = await db
      .from('vurdering_upload_zoner')
      .upsert(
        { sag_id: sagId, tenant_id: auth.tenantId, zone_type: zoneType },
        { onConflict: 'sag_id,zone_type' }
      )
      .select('id')
      .single();

    if (!zone) return NextResponse.json({ error: 'Kunne ikke oprette zone' }, { status: 500 });

    // Upload til storage
    const buffer = Buffer.from(await file.arrayBuffer());
    const storagePath = `${auth.tenantId}/vr/${sagId}/${randomUUID()}-${sanitizeFilename(file.name)}`;
    const { error: uploadErr } = await admin.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: mime,
      upsert: false,
    });
    if (uploadErr) {
      logger.error(`[vurdering/upload] Storage: ${uploadErr.message}`);
      return NextResponse.json({ error: `Upload fejlede: ${uploadErr.message}` }, { status: 500 });
    }

    // Opret dokument-row
    const { data: doc, error: docErr } = await db
      .from('vurdering_dokumenter')
      .insert({
        sag_id: sagId,
        zone_id: zone.id,
        tenant_id: auth.tenantId,
        storage_path: storagePath,
        original_name: file.name,
        mime_type: mime,
        size_bytes: file.size,
        parse_status: 'parsing',
        uploaded_by: auth.userId,
      })
      .select('id')
      .single();

    if (docErr || !doc) {
      logger.error(`[vurdering/upload] DB: ${docErr?.message}`);
      return NextResponse.json({ error: 'Kunne ikke gemme dokument' }, { status: 500 });
    }

    // AI-parsing via Claude
    let parsedData: Record<string, unknown> | null = null;
    try {
      const extracted = await extractTextFromBuffer(buffer, fileType);
      const text = extracted.ok ? extracted.text : null;
      if (text && text.length > 10) {
        const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
        if (apiKey) {
          const Anthropic = (await import('@anthropic-ai/sdk')).default;
          const client = new Anthropic({ apiKey, timeout: 100_000 });
          const prompt = ZONE_PROMPTS[zoneType] ?? ZONE_PROMPTS.oevrige;

          const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 4000,
            system: prompt,
            messages: [{ role: 'user', content: text.slice(0, 15000) }],
          });

          const textBlock = response.content.find((b) => b.type === 'text');
          if (textBlock && textBlock.type === 'text') {
            const cleaned = textBlock.text.replace(/```json\n?|\n?```/g, '').trim();
            parsedData = JSON.parse(cleaned);
          }
        }
      }

      await db
        .from('vurdering_dokumenter')
        .update({
          parse_status: 'parsed',
          parsed_data: parsedData,
        })
        .eq('id', doc.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .from('vurdering_dokumenter')
        .update({
          parse_status: 'failed',
          parse_error: msg,
        })
        .eq('id', doc.id);
      logger.error(`[vurdering/upload] Parse: ${msg}`);
    }

    return NextResponse.json({
      document: { id: doc.id, zone_type: zoneType, parse_status: parsedData ? 'parsed' : 'failed' },
      parsed_data: parsedData,
    });
  } catch (err) {
    logger.error('[vurdering/upload]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
