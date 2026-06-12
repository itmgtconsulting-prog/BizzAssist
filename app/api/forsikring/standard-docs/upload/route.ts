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
import { getUserDomainId } from '@/app/lib/forsikring/standardDocDomain';

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

    // ── 2. AI-klassificering: selskab, område, gyldig_fra, validering ────────
    let resolvedSelskab = selskabInput;
    let resolvedTitel = titelInput || file.name.replace(/\.pdf$/i, '');
    let resolvedOmraade: string | null = null;
    let resolvedGyldigFra: string | null = null;
    let resolvedSelskabNorm: string | null = null;
    let isValidStandard = true;
    let aiMetadata: Record<string, unknown> = {};

    {
      const aiBlocked = await assertAiAllowed(auth.userId);
      if (!aiBlocked) {
        try {
          const anthropic = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY });
          const pdfBase64 = Buffer.from(fileBytes).toString('base64');
          const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
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
                    text: `Analysér dette dokument og returnér KUN JSON:
{
  "selskab": "Forsikringsselskabets fulde navn",
  "selskab_normaliseret": "Kort standardnavn (fx 'Topdanmark', 'Tryg', 'Codan', 'Alm. Brand', 'IF', 'GF')",
  "titel": "Dokumentets titel/betingelsesnummer",
  "omraade": "ejendom|erhverv|ansvar|brand|motor|cyber|rejse|ulykke|sundhed|liv|andet",
  "gyldig_fra": "YYYY-MM-DD eller null hvis ukendt",
  "er_standard_betingelser": true/false,
  "begrundelse": "Kort forklaring af klassificeringen"
}

VIGTIGT:
- "er_standard_betingelser" = true HVIS dokumentet er generelle forsikringsbetingelser/vilkår der gælder for en forsikringstype (IKKE en individuel police, faktura, følgebrev eller kundespecifikt dokument)
- "omraade" skal matche den forsikringstype betingelserne dækker
- "gyldig_fra" er typisk på forsiden eller i en ikrafttrædelsesdato
- Svar KUN med JSON — ingen markdown, ingen forklaring.`,
                  },
                ],
              },
            ],
          });

          const textContent = resp.content.find((b) => b.type === 'text');
          if (textContent?.type === 'text') {
            const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]) as {
                selskab?: string;
                selskab_normaliseret?: string;
                titel?: string;
                omraade?: string;
                gyldig_fra?: string | null;
                er_standard_betingelser?: boolean;
                begrundelse?: string;
              };
              if (parsed.selskab && !selskabInput) resolvedSelskab = parsed.selskab;
              if (parsed.selskab_normaliseret) resolvedSelskabNorm = parsed.selskab_normaliseret;
              if (parsed.titel && !titelInput) resolvedTitel = parsed.titel;
              if (parsed.omraade) resolvedOmraade = parsed.omraade;
              if (parsed.gyldig_fra) resolvedGyldigFra = parsed.gyldig_fra;
              if (parsed.er_standard_betingelser === false) isValidStandard = false;
              aiMetadata = parsed;
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
          /* AI-klassificering er best-effort — continue uden */
        }
      }
    }

    if (!resolvedSelskab) resolvedSelskab = 'Ukendt';

    // ── 2b. Content-hash for dedup (baseret på filnavn + størrelse + første bytes) ──
    const crypto = await import('node:crypto');
    const hashSource = `${file.name}|${file.size}|${Buffer.from(fileBytes.slice(0, 4096)).toString('base64')}`;
    const contentHash = crypto.createHash('sha256').update(hashSource).digest('hex');

    // ── 3. Dedup-check: hvis content_hash allerede eksisterer, returner eksisterende ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = serviceClient as any;

    const { data: existing } = await svc
      .from('forsikring_standard_doc')
      .select('id, selskab, kategori, titel, source_url, added_via, created_at, is_valid_standard')
      .eq('content_hash', contentHash)
      .maybeSingle();

    if (existing) {
      // Duplikat fundet — returner eksisterende med flag
      return NextResponse.json({
        ...existing,
        duplicate: true,
        message: 'Dokumentet eksisterer allerede i biblioteket',
      });
    }

    // ── 4. Opret forsikring_standard_doc post ────────────────────────────────
    // BIZZ-2104: Domain-medlemmer deler automatisk (visibility='domain' med
    // ÆGTE domain_id i added_by_domain — RLS matcher domain_member.domain_id);
    // standalone-brugere får private. Tidligere blev tenant_id gemt og
    // visibility aldrig sat, så pdf-uploads var altid private-by-default.
    const domainId = await getUserDomainId(auth.userId);

    const { data: insertData, error: insertErr } = await svc
      .from('forsikring_standard_doc')
      .insert({
        selskab: resolvedSelskab,
        selskab_normaliseret: resolvedSelskabNorm,
        kategori: resolvedOmraade ?? kategoriInput,
        omraade: resolvedOmraade,
        titel: resolvedTitel,
        source_url: sourceUrl,
        content_hash: contentHash,
        gyldig_fra: resolvedGyldigFra,
        is_valid_standard: isValidStandard,
        ai_metadata: aiMetadata,
        added_via: 'pdf_upload',
        added_by_user: auth.userId,
        added_by_domain: domainId,
        visibility: domainId ? 'domain' : 'private',
        verified: false,
      })
      .select(
        'id, selskab, kategori, titel, source_url, added_via, created_at, omraade, gyldig_fra, is_valid_standard'
      )
      .single();

    if (insertErr) {
      logger.error('std-doc insert error', { message: insertErr.message });
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    return NextResponse.json({
      ...insertData,
      duplicate: false,
      is_valid_standard: isValidStandard,
    });
  } catch (err) {
    logger.error('std-doc upload unexpected error', { message: String(err) });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
