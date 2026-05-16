/**
 * NL → QueryPlan router (BIZZ-1563).
 *
 * Konverterer et naturligt sprog-spørgsmål til en typesikker QueryPlan ved
 * hjælp af Claude med strikt constrained output. AI'en kan aldrig
 * hallucinere kolonner — output valideres mod metric/dimension-katalogerne
 * (L2.1 / BIZZ-1562) før returneret.
 *
 * Pipeline:
 *   1. Embed-based persona-detection (lightweight keyword for v1)
 *   2. Build constrained Claude-prompt med katalog-summary
 *   3. Call Claude med JSON-output schema
 *   4. Validér plan mod katalog
 *   5. Confidence-scoring → plan / clarification / fallback-til-generativ
 *
 * @module app/lib/dataIntelligence/semantic/router
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/app/lib/logger';
import { METRICS } from './metrics';
import { DIMENSIONS } from './dimensions';
import { validateQueryPlan, type QueryPlan } from './queryPlan';

/** Persona — påvirker default sort/limit + system prompt vægtning */
export type Persona = 'journalist' | 'finans' | 'maegler' | 'general';

/** Chat-historie for konvers-mode (Lag 1.2 BIZZ-1560) */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Routing-resultat */
export type RouteResult =
  | { kind: 'plan'; plan: QueryPlan; confidence: number; persona: Persona }
  | {
      kind: 'needs_clarification';
      message: string;
      alternatives: Array<{ description: string; plan: QueryPlan }>;
    }
  | { kind: 'fallback_to_generative'; reason: string };

/** Persona-detection via keyword-matching (v1 — kan erstattes med embeddings) */
const PERSONA_KEYWORDS: Record<Exclude<Persona, 'general'>, string[]> = {
  journalist: [
    'hvor mange',
    'fordeling',
    'top',
    'rangér',
    'rangering',
    'liste',
    'i alt',
    'totalt',
    'andel',
  ],
  finans: [
    'samlet',
    'værdi',
    'egenkapital',
    'omsætning',
    'koncern',
    'holding',
    'ejer-lag',
    'beneficial',
    'aktiv',
    'gæld',
    'pant',
    'belåning',
    'porteføl',
  ],
  maegler: [
    'sammenligning',
    'm²',
    'kvadratmeter',
    'salgspris',
    'købsbeløb',
    'købesum',
    'parcelhus',
    'lejlighed',
    'mægler',
    'sammenligne',
    'sammenlignelige',
  ],
};

/**
 * Detect persona baseret på keywords i spørgsmålet.
 * Fallback til 'general' hvis ingen klar match.
 *
 * @param question - Naturligt sprog-spørgsmål
 * @returns Detekteret persona
 */
export function detectPersona(question: string): Persona {
  const q = question.toLowerCase();
  const scores: Record<string, number> = {};
  for (const [persona, keywords] of Object.entries(PERSONA_KEYWORDS)) {
    scores[persona] = keywords.filter((kw) => q.includes(kw)).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0) return best[0] as Persona;
  return 'general';
}

/**
 * Byg system-prompt med katalog som constrained-output kontekst.
 * Holder prompten kompakt ved kun at vise name + displayName + description.
 *
 * @param persona - Detekteret persona
 * @returns System-prompt string
 */
function buildRouterPrompt(persona: Persona): string {
  const metricList = METRICS.map((m) => `  - ${m.name} (${m.displayName}): ${m.description}`).join(
    '\n'
  );
  const dimList = DIMENSIONS.map(
    (d) => `  - ${d.name} (${d.displayName}, type=${d.type}): ${d.description}`
  ).join('\n');

  const personaInstruction =
    persona === 'journalist'
      ? 'Brugeren er journalist — foretrækker top-N lister og fordelinger. Default sort DESC efter primær metric. Default limit 10-20.'
      : persona === 'finans'
        ? 'Brugeren er finansiel rådgiver — fokus på værdier, ejerskab, koncerner. Default sort DESC efter sum-metrics. Default limit 50.'
        : persona === 'maegler'
          ? 'Brugeren er ejendomsmægler — fokus på handler, m²-priser, sammenligninger. Default chartHint=line for tidsserier. Default limit 100.'
          : 'Generel bruger — pålideligt fald-tilbage på rimelige defaults.';

  return `Du er en query-planner for BizzAssist Data Intelligence. Brugeren stiller et spørgsmål på dansk om virksomheds- og ejendomsdata. Du oversætter spørgsmålet til en struktureret JSON-plan.

PERSONA: ${persona}
${personaInstruction}

OUTPUT-FORMAT (returner KUN JSON, intet markdown):
{
  "plan": {
    "metrics": ["metric_name_1", "metric_name_2"],
    "dimensions": ["dim_name_1"],
    "filters": [{"dimension": "kommune_kode", "op": "eq", "value": 101}],
    "timeRange": {"dimension": "dato", "preset": "last_12_months", "grain": "month"},
    "sort": {"by": "metric_name_1", "direction": "desc"},
    "limit": 10,
    "chartHint": "line"
  },
  "confidence": 0.85,
  "reasoning": "kort dansk forklaring",
  "alternatives": []
}

REGLER:
1. Brug KUN metric/dimension-navne fra de to lister nedenfor — opfind ALDRIG nye.
2. confidence (0-1): 1.0 = entydigt match; 0.7-0.9 = god match med gættet time-range eller default; 0.4-0.7 = tvetydigt (returnér 2-3 alternatives); <0.4 = giv op (sæt confidence til 0.0).
3. Hvis confidence < 0.4 ELLER hvis ingen metric matcher, returner: {"confidence": 0.0, "reasoning": "kan ikke besvares med tilgængelige metrics", "alternatives": [forslag]}
4. timeRange preset: 'last_7_days' | 'last_30_days' | 'last_90_days' | 'last_12_months' | 'ytd' | 'qtd' | 'mtd' | 'last_year' | 'all_time'. Brug from/to ISO-dato (YYYY-MM-DD) hvis brugeren specificerer eksakt periode.
5. Filter operatorer: 'eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'like', 'ilike', 'is_null', 'is_not_null'.
6. ChartHint vælges af dig: 'line' (tidsserier), 'bar' (top-N), 'pie' (fordeling med ≤7 kategorier), 'table' (mange kolonner/rækker), 'scorecard' (1 tal).
7. Limit: default 100, brug 10-20 for top-N spørgsmål, brug 1 for scorecard.

METRICS (${METRICS.length}):
${metricList}

DIMENSIONS (${DIMENSIONS.length}):
${dimList}`;
}

/**
 * Confidence-threshold: under dette returner clarification eller fallback
 */
const MIN_PLAN_CONFIDENCE = 0.7;
const MIN_CLARIFICATION_CONFIDENCE = 0.4;

/**
 * Rå Claude-respons-format
 */
interface RouterResponse {
  plan?: QueryPlan;
  confidence: number;
  reasoning?: string;
  alternatives?: Array<{ description: string; plan: QueryPlan }>;
}

/**
 * Hovedfunktion — route NL → QueryPlan.
 *
 * @param question - Bruger-spørgsmål (dansk)
 * @param options - Optional context (history, persona override, claudeKey)
 * @returns RouteResult
 */
export async function routeQuery(
  question: string,
  options: {
    history?: ChatTurn[];
    personaOverride?: Persona;
    apiKey?: string;
  } = {}
): Promise<RouteResult> {
  const persona = options.personaOverride ?? detectPersona(question);
  const apiKey = options.apiKey ?? process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return { kind: 'fallback_to_generative', reason: 'Claude API-nøgle mangler' };
  }

  const systemPrompt = buildRouterPrompt(persona);
  const userMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of options.history ?? []) {
    userMessages.push({ role: turn.role, content: turn.content });
  }
  userMessages.push({ role: 'user', content: question });

  let raw: string;
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: userMessages,
      },
      { signal: AbortSignal.timeout(20_000) }
    );
    const text = resp.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('');
    raw = text.trim();
  } catch (err) {
    logger.error('[router] Claude fejl:', err);
    return { kind: 'fallback_to_generative', reason: 'Claude API fejl' };
  }

  // Strip markdown fences hvis modellen alligevel pakker JSON ind
  const jsonStr = raw.replace(/^```json\s*/, '').replace(/```\s*$/, '');

  let parsed: RouterResponse;
  try {
    parsed = JSON.parse(jsonStr) as RouterResponse;
  } catch {
    logger.warn('[router] Ugyldigt JSON fra Claude:', raw.substring(0, 200));
    return { kind: 'fallback_to_generative', reason: 'Ugyldigt JSON-format' };
  }

  // Lav confidence: fald tilbage til generativ
  if (parsed.confidence < MIN_CLARIFICATION_CONFIDENCE) {
    return {
      kind: 'fallback_to_generative',
      reason: parsed.reasoning ?? 'Lav confidence',
    };
  }

  // Medium confidence: clarification med alternatives
  if (parsed.confidence < MIN_PLAN_CONFIDENCE) {
    const alts = parsed.alternatives ?? [];
    return {
      kind: 'needs_clarification',
      message: parsed.reasoning ?? 'Mange mulige fortolkninger — vælg en:',
      alternatives: alts.slice(0, 3),
    };
  }

  // Høj confidence: validér plan mod katalog
  if (!parsed.plan) {
    return { kind: 'fallback_to_generative', reason: 'Plan mangler i Claude-output' };
  }
  const validation = validateQueryPlan(parsed.plan);
  if (!validation.ok) {
    logger.warn('[router] Plan-validation failed:', validation.reason);
    return { kind: 'fallback_to_generative', reason: validation.reason };
  }

  return { kind: 'plan', plan: parsed.plan, confidence: parsed.confidence, persona };
}
