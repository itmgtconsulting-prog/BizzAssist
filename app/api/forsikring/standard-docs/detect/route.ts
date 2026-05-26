/**
 * POST /api/forsikring/standard-docs/detect
 *
 * AI-baseret auto-detektion af standard forsikringsbetingelser
 * fra uploadede police-dokumenter.
 *
 * BIZZ-1890: Feature 3 — AI læser de uploadede police-filer og foreslår
 * relevante standard-betingelser baseret på forsikringsselskab og policetype.
 *
 * Flow:
 *   1. Læs parsede police-dokumenter fra forsikring_documents
 *   2. Claude identificerer forsikringsselskaber og policekategorier
 *   3. Søg i eksisterende forsikring_standard_doc for matches
 *   4. Brug discover-logik for nye selskaber uden eksisterende docs
 *
 * @param document_ids - IDs fra forsikring_documents tabel
 * @returns { results: DiscoveredStandardDoc[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { recordAiUsage } from '@/app/lib/aiTracking';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 45;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const DetectSchema = z.object({
  document_ids: z.array(z.string().uuid()).min(1).max(20),
});

/** Standard-dokument foreslået til bruger */
export interface DetectedStandardDoc {
  titel: string;
  source_url: string;
  kategori: string;
  selskab: string;
  confidence: 'high' | 'medium' | 'low';
  /** ID i forsikring_standard_doc hvis dokumentet allerede kendes */
  existing_id?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as unknown as NextResponse;

  const rl = await checkRateLimit(request, aiRateLimit);
  if (rl) return rl;

  const body = await request.json().catch(() => null);
  const parsed = DetectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Ugyldigt input — kræver document_ids array' },
      { status: 400 }
    );
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) as any;

  try {
    // ── 1. Hent parsede dokumenter ───────────────────────────────────────────
    const { data: docs } = await svc
      .from('forsikring_documents')
      .select('id, original_name, parsed_content, parse_status')
      .in('id', parsed.data.document_ids)
      .eq('parse_status', 'parsed');

    const docList = (docs ?? []) as Array<{
      id: string;
      original_name: string;
      parsed_content: unknown;
    }>;

    if (docList.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // Byg kontekst-tekst fra parsede dokumenter
    const contextParts: string[] = [];
    for (const doc of docList) {
      const content = doc.parsed_content;
      let text = '';
      if (typeof content === 'string') {
        text = content.slice(0, 800);
      } else if (content && typeof content === 'object') {
        text = JSON.stringify(content).slice(0, 800);
      }
      if (text) contextParts.push(`Dokument: ${doc.original_name}\n${text}`);
    }

    const context = contextParts.join('\n\n---\n\n');

    // ── 2. Claude identificerer forsikringsselskaber ─────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY });
    let totalTokens = 0;

    const extractResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Du ser udvalgte tekst-uddrag fra forsikringsdokumenter. Identificer ALLE forsikringsselskaber og policekategorier nævnt.

Dokumenter:
${context}

Svar KUN med JSON-array: [{"selskab": "...", "kategori": "ejendom|erhverv|bil|liv|andet"}]
Maksimalt 5 unikke selskaber. Ingen forklaring.`,
        },
      ],
    });

    totalTokens += extractResp.usage.input_tokens + extractResp.usage.output_tokens;

    const extractText = extractResp.content.find((b) => b.type === 'text');
    let insurers: Array<{ selskab: string; kategori: string }> = [];

    if (extractText?.type === 'text') {
      const arrMatch = extractText.text.match(/\[[\s\S]*?\]/);
      if (arrMatch) {
        try {
          insurers = JSON.parse(arrMatch[0]) as Array<{ selskab: string; kategori: string }>;
        } catch {
          /* parse fejl — fortsæt med tom liste */
        }
      }
    }

    if (insurers.length === 0) {
      await recordAiUsage({
        userId: auth.userId,
        tenantId: auth.tenantId,
        route: 'ai.forsikring.std-detect',
        inputTokens: totalTokens,
        outputTokens: 0,
      });
      return NextResponse.json({ results: [] });
    }

    // ── 3. Søg efter eksisterende standard_docs ──────────────────────────────
    const results: DetectedStandardDoc[] = [];
    const seenUrls = new Set<string>();

    for (const { selskab, kategori } of insurers) {
      // Søg i forsikring_standard_doc
      const { data: existingDocs } = await svc
        .from('forsikring_standard_doc')
        .select('id, selskab, kategori, titel, source_url')
        .ilike('selskab', `%${selskab}%`)
        .limit(5);

      for (const doc of (existingDocs ?? []) as Array<{
        id: string;
        selskab: string;
        kategori: string;
        titel: string;
        source_url: string;
      }>) {
        if (!seenUrls.has(doc.source_url)) {
          seenUrls.add(doc.source_url);
          results.push({
            titel: doc.titel,
            source_url: doc.source_url,
            kategori: doc.kategori,
            selskab: doc.selskab,
            confidence: 'high',
            existing_id: doc.id,
          });
        }
      }

      // Hvis ingen eksisterende docs fundet, brug AI-discovery
      if (!existingDocs || existingDocs.length === 0) {
        try {
          const discoverResp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages: [
              {
                role: 'user',
                content: `Find standard forsikringsbetingelser URL'er for ${selskab} indenfor kategorien ${kategori}.
Svar KUN med JSON-array (max 3 resultater):
[{"titel": "...", "source_url": "https://...", "kategori": "${kategori}", "confidence": "high|medium|low"}]
Ingen forklaring. Returner kun kendte, officielle URLs fra ${selskab}'s hjemmeside.`,
              },
            ],
          });

          totalTokens += discoverResp.usage.input_tokens + discoverResp.usage.output_tokens;

          const discoverText = discoverResp.content.find((b) => b.type === 'text');
          if (discoverText?.type === 'text') {
            const arrMatch = discoverText.text.match(/\[[\s\S]*?\]/);
            if (arrMatch) {
              const newDocs = JSON.parse(arrMatch[0]) as Array<{
                titel: string;
                source_url: string;
                kategori: string;
                confidence: string;
              }>;
              for (const d of newDocs) {
                if (d.source_url && !seenUrls.has(d.source_url)) {
                  seenUrls.add(d.source_url);
                  results.push({
                    titel: d.titel,
                    source_url: d.source_url,
                    kategori: d.kategori ?? kategori,
                    selskab,
                    confidence: (d.confidence ?? 'medium') as DetectedStandardDoc['confidence'],
                  });
                }
              }
            }
          }
        } catch {
          /* discover fejl — skip dette selskab */
        }
      }
    }

    await recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'ai.forsikring.std-detect',
      inputTokens: totalTokens,
      outputTokens: 0,
    });

    return NextResponse.json({ results });
  } catch (err) {
    logger.error('std-doc detect error', { message: String(err) });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
