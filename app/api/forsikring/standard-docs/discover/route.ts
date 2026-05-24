/**
 * POST /api/forsikring/standard-docs/discover
 *
 * AI-baseret discovery af standard forsikringsbetingelser.
 * Givet et forsikringsselskabs navn og en policekategori, bruger Claude
 * til at identificere relevante standard-betingelser og deres URLs.
 *
 * BIZZ-1833 Fase 2: AI-discovery endpoint.
 *
 * @param selskab - Forsikringsselskabets navn (fx "Topdanmark")
 * @param kategori - Forsikringskategori (fx "ejendom", "erhverv")
 * @param context - Valgfri kontekst fra uploadede policer (hjælper AI med præcision)
 * @returns Array af fundne standard-betingelser med titel, URL og confidence
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { recordAiUsage } from '@/app/lib/aiTracking';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** Zod schema for POST body */
const DiscoverSchema = z.object({
  selskab: z.string().min(1),
  kategori: z.string().min(1),
  context: z.string().optional(),
});

/** AI-fundet standard-dokument */
export interface DiscoveredStandardDoc {
  titel: string;
  source_url: string;
  kategori: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
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

  const parsed = DiscoverSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ugyldigt input' }, { status: 400 });
  }
  const { selskab, kategori, context } = parsed.data;

  try {
    const systemPrompt = `Du er en dansk forsikringsekspert. Din opgave er at finde standard forsikringsbetingelser fra et forsikringsselskabs hjemmeside.

Du modtager:
1. Forsikringsselskabets navn
2. Forsikringskategori (ejendom, erhverv, ansvar, arbejdsskade, cyber osv.)
3. Eventuelt kontekst fra en uploadet police

Din opgave: Find de mest relevante standard forsikringsbetingelser (generelle vilkår, fællesvilkår, betingelser) som typisk supplerer en individuel police fra dette selskab.

VIGTIGT:
- Returnér KUN betingelser du er rimelig sikker på eksisterer
- Inkludér den fulde URL til dokumentet (typisk PDF)
- Danske forsikringsselskaber: Topdanmark, Tryg, Codan, Alm. Brand, GF Forsikring, Gjensidige, IF, Privatsikring, Bauta, Runa osv.
- Standard-betingelser er typisk på selskabets hjemmeside under "Betingelser", "Vilkår" eller "Dokumenter"
- confidence: "high" (>80% sikker på URL virker), "medium" (50-80%), "low" (<50%)

Svar UDELUKKENDE med valid JSON array:
[{"titel": "Forsikringsbetingelser Ejendom 2024", "source_url": "https://...", "kategori": "ejendom", "confidence": "high", "reasoning": "Standard ejendomsforsikringsbetingelser fra selskabets hjemmeside"}]

Ingen markdown, ingen forklaring uden for arrayet.`;

    const userPrompt = `Forsikringsselskab: ${selskab}
Kategori: ${kategori}
${context ? `\nKontekst fra uploadet police:\n${context.slice(0, 2000)}` : ''}

Find standard forsikringsbetingelser (generelle vilkår) for denne type forsikring fra ${selskab}.`;

    const client = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Track AI usage
    void recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'ai.forsikring-discover',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: 'claude-sonnet-4-6',
    });

    // Parse response
    const aiText = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '[]';
    let results: DiscoveredStandardDoc[] = [];
    try {
      const cleaned = aiText
        .replace(/```json?\s*/g, '')
        .replace(/```/g, '')
        .trim();
      results = JSON.parse(cleaned);
    } catch {
      logger.warn('[standard-docs/discover] Could not parse AI response:', aiText.slice(0, 200));
      return NextResponse.json({ results: [] });
    }

    // Validér
    const validConfidences = new Set(['high', 'medium', 'low']);
    results = results.filter((r) => r.titel && r.source_url && validConfidences.has(r.confidence));

    return NextResponse.json({ results });
  } catch (err) {
    logger.error('[standard-docs/discover] Error:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
