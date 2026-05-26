/**
 * POST /api/forsikring/standard-docs/upload
 *
 * Uploader en PDF-fil med standard forsikringsbetingelser til Supabase Storage
 * og opretter en forsikring_standard_doc-post med metadata.
 *
 * BIZZ-1890: PDF-upload feature for standard betingelser.
 *
 * Body: multipart/form-data
 *   - file:     PDF-filen (max 20 MB)
 *   - selskab:  Forsikringsselskabets navn (valgfri — AI ekstraherer hvis udeladt)
 *   - titel:    Dokumentets titel (valgfri — filnavn bruges som fallback)
 *   - kategori: Policekategori (valgfri, default 'ejendom')
 *
 * @returns { id, selskab, titel, kategori, source_url, added_via: 'pdf_upload' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { recordAiUsage } from '@/app/lib/aiTracking';

export const runtime = 'nodejs';
export const maxDuration = 30;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const BUCKET = 'forsikring-documents';
/** 20 MB i bytes */
const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rl = await checkRateLimit(request, heavyRateLimit);
  if (rl) return rl;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Ugyldig form-data' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Mangler fil-felt' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Filen er tom' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Filen er for stor (max 20 MB)' }, { status: 413 });
  }
  if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json({ error: 'Kun PDF-filer er understøttet' }, { status: 400 });
  }

  const selskabInput = (formData.get('selskab') as string | null)?.trim() ?? '';
  const titelInput = (formData.get('titel') as string | null)?.trim() ?? '';
  const kategoriInput = (formData.get('kategori') as string | null)?.trim() || 'ejendom';

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // ── 1. Upload til Supabase Storage ──────────────────────────────────────
    const fileBytes = await file.arrayBuffer();
    const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const storagePath = `std-docs/${auth.tenantId}/${randomUUID()}-${safeFileName}`;

    const { error: storageErr } = await serviceClient.storage
      .from(BUCKET)
      .upload(storagePath, fileBytes, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (storageErr) {
      logger.error('std-doc upload storage error', { message: storageErr.message });
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // Generer signed URL (10 år = 315 360 000 sekunder)
    const { data: signedData, error: signedErr } = await serviceClient.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, 315_360_000);

    if (signedErr || !signedData?.signedUrl) {
      logger.error('std-doc signed URL error', { message: signedErr?.message });
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    const sourceUrl = signedData.signedUrl;

    // ── 2. Ekstraher metadata med AI (kun hvis selskab/titel mangler) ────────
    let resolvedSelskab = selskabInput;
    let resolvedTitel = titelInput || file.name.replace(/\.pdf$/i, '');

    if (!resolvedSelskab) {
      const aiBlocked = await assertAiAllowed(auth.userId);
      if (!aiBlocked) {
        try {
          const anthropic = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY });
          const pdfBase64 = Buffer.from(fileBytes).toString('base64');
          const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'document',
                    source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
                  },
                  {
                    type: 'text',
                    text: 'Ekstraher fra dette forsikringsdokument: forsikringsselskabets navn (selskab) og dokumentets titel. Svar KUN med JSON: {"selskab": "...", "titel": "..."}. Ingen forklaring.',
                  },
                ],
              },
            ],
          });

          const textContent = resp.content.find((b) => b.type === 'text');
          if (textContent?.type === 'text') {
            const jsonMatch = textContent.text.match(/\{[^}]+\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]) as { selskab?: string; titel?: string };
              if (parsed.selskab) resolvedSelskab = parsed.selskab;
              if (parsed.titel && !titelInput) resolvedTitel = parsed.titel;
            }
          }

          await recordAiUsage({
            userId: auth.userId,
            tenantId: auth.tenantId,
            route: 'ai.forsikring.std-upload',
            inputTokens: resp.usage.input_tokens,
            outputTokens: resp.usage.output_tokens,
          });
        } catch {
          /* AI-ekstraktion er best-effort — continue uden */
        }
      }
    }

    if (!resolvedSelskab) resolvedSelskab = 'Ukendt';

    // ── 3. Opret forsikring_standard_doc post ────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = serviceClient as any;
    const contentHash = randomUUID(); // Simpel unik hash for PDF-uploads

    const { data: insertData, error: insertErr } = await svc
      .from('forsikring_standard_doc')
      .insert({
        selskab: resolvedSelskab,
        kategori: kategoriInput,
        titel: resolvedTitel,
        source_url: sourceUrl,
        content_hash: contentHash,
        added_via: 'pdf_upload',
        added_by_user: auth.userId,
        added_by_domain: auth.tenantId,
        verified: false,
      })
      .select('id, selskab, kategori, titel, source_url, added_via, created_at')
      .single();

    if (insertErr) {
      logger.error('std-doc insert error', { message: insertErr.message });
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    return NextResponse.json(insertData);
  } catch (err) {
    logger.error('std-doc upload unexpected error', { message: String(err) });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
