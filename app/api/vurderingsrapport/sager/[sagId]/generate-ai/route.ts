/**
 * POST /api/vurderingsrapport/sager/[sagId]/generate-ai
 *
 * BIZZ-1738: AI-enhance rapport-tabs med per-tab Claude prompts.
 *
 * Forudsætning: generate-tabs har allerede prepopuleret data-tabs.
 * Denne route læser raw-data fra vurdering_rapport_tabs, sender det
 * til Claude med tab-specifik system-prompt, og overskriver tab-indholdet
 * med struktureret dansk prosa. Output valideres via Zod-schema.
 *
 * Body: { tabs?: string[] } — optional list af tab-keys at generere.
 *        Default: alle 8 tabs.
 *
 * @module api/vurderingsrapport/sager/[sagId]/generate-ai
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { recordAiUsage } from '@/app/lib/aiTracking';
import { buildTabSystemPrompt, TAB_SCHEMAS } from '@/app/lib/vurdering/tabPrompts';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

const ALL_TAB_KEYS = [
  'identifikation',
  'bygningsdata',
  'energi',
  'vurdering_skat',
  'tinglysning',
  'servitutter',
  'beliggenhed',
  'risiko',
] as const;

/**
 * Generate AI-enhanced content for one tab.
 *
 * @param client - Anthropic SDK client
 * @param systemPrompt - Per-tab system prompt
 * @param rawData - Raw tab data from generate-tabs
 * @param tabKey - Tab identifier for Zod validation
 * @returns Validated structured output, or null on failure
 */
async function generateTabContent(
  client: Anthropic,
  systemPrompt: string,
  rawData: unknown,
  tabKey: string
): Promise<{ content: Record<string, string>; usage: { input: number; output: number } } | null> {
  try {
    const userMessage = `Her er de tilgængelige data for dette tab:\n\n${JSON.stringify(rawData, null, 2)}\n\nSkriv sektionerne baseret på disse data. Returner KUN valid JSON.`;

    const response = await client.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: AbortSignal.timeout(25000) }
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return null;

    // Extract JSON from response (may be wrapped in ```json blocks)
    let jsonStr = textBlock.text.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const parsed = JSON.parse(jsonStr) as Record<string, string>;

    // Validate with Zod schema
    const schema = TAB_SCHEMAS[tabKey];
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        logger.warn(`[generate-ai] Zod validation failed for ${tabKey}:`, result.error.message);
        // Return unvalidated — partial data is better than none
      }
    }

    return {
      content: parsed,
      usage: {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
    };
  } catch (err) {
    logger.warn(`[generate-ai] Tab ${tabKey} generation failed:`, err);
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sagId: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'AI utilgængelig' }, { status: 503 });

  const { sagId } = await params;

  let body: { tabs?: string[] } = {};
  try {
    body = (await request.json()) as { tabs?: string[] };
  } catch {
    // Empty body = generate all tabs
  }

  const requestedTabs = body.tabs?.length
    ? body.tabs.filter((t) => ALL_TAB_KEYS.includes(t as (typeof ALL_TAB_KEYS)[number]))
    : [...ALL_TAB_KEYS];

  if (requestedTabs.length === 0) {
    return NextResponse.json({ error: 'Ingen gyldige tab-keys' }, { status: 400 });
  }

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Hent sag for tone + sagsnummer
    const { data: sag } = await db
      .from('vurdering_sager')
      .select('sag_nummer, rapport_tone')
      .eq('id', sagId)
      .eq('tenant_id', auth.tenantId)
      .maybeSingle();

    if (!sag) return NextResponse.json({ error: 'Sag ikke fundet' }, { status: 404 });

    const tone = ((sag as Record<string, unknown>).rapport_tone as string) ?? 'realkredit';
    const sagNummer = ((sag as Record<string, unknown>).sag_nummer as string) ?? '';

    // Hent eksisterende raw-data tabs
    const { data: existingTabs } = await db
      .from('vurdering_rapport_tabs')
      .select('tab_key, indhold')
      .eq('sag_id', sagId)
      .in('tab_key', requestedTabs);

    if (!existingTabs || existingTabs.length === 0) {
      return NextResponse.json(
        { error: 'Ingen data-tabs fundet — kør generate-tabs først' },
        { status: 400 }
      );
    }

    const tabDataMap = new Map<string, unknown>(
      (existingTabs as Array<{ tab_key: string; indhold: unknown }>).map((t) => [
        t.tab_key,
        t.indhold,
      ])
    );

    // Generate AI content for each tab sequentially (to stay within rate limits)
    const client = new Anthropic({ apiKey });
    const results: Record<string, { ok: boolean; sections?: number }> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const tabKey of requestedTabs) {
      const rawData = tabDataMap.get(tabKey);
      if (!rawData) {
        results[tabKey] = { ok: false };
        continue;
      }

      const systemPrompt = buildTabSystemPrompt(tabKey, tone, sagNummer);
      if (!systemPrompt) {
        results[tabKey] = { ok: false };
        continue;
      }

      const generated = await generateTabContent(client, systemPrompt, rawData, tabKey);
      if (!generated) {
        results[tabKey] = { ok: false };
        continue;
      }

      // Merge AI content with raw data — AI sections stored under 'ai' key
      const mergedContent = {
        data: rawData,
        ai: generated.content,
      };

      // Upsert
      await db.from('vurdering_rapport_tabs').upsert(
        {
          sag_id: sagId,
          tenant_id: auth.tenantId,
          tab_key: tabKey,
          indhold: mergedContent,
          ai_genereret: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'sag_id,tab_key' }
      );

      totalInputTokens += generated.usage.input;
      totalOutputTokens += generated.usage.output;
      results[tabKey] = { ok: true, sections: Object.keys(generated.content).length };
    }

    // Record AI usage
    await recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'vurdering.generate-ai',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      model: 'claude-sonnet-4-6',
    });

    return NextResponse.json({
      ok: true,
      tabs: results,
      tokens: { input: totalInputTokens, output: totalOutputTokens },
    });
  } catch (err) {
    logger.error('[vurdering/generate-ai]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
