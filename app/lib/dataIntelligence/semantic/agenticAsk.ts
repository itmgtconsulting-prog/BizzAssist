/**
 * Agentic ask-orchestrator for Data Intelligence (BIZZ-1560, L1.2).
 *
 * Wires hele 3-lag stack'en sammen i én callable funktion:
 *
 *   user-spørgsmål
 *      ↓
 *   L2.2 router (NL → QueryPlan)   ─ kan returnere clarify/decline
 *      ↓
 *   L3 cache (scorecard/MV/Redis)  ─ instant svar hvis hit
 *      ↓
 *   L2.3 SQL compiler + execute    ─ "rigtigt" semantic-svar
 *      ↓
 *   Retry-on-empty (≤2 iterations) ─ hvis 0 rows, prøv at relaxe plan
 *      ↓
 *   AgenticResult
 *
 * Hver beslutning logges i AgenticTrace så caller kan vise transparent
 * "AI prøver igen (1/2)..." indikator og debug-info.
 *
 * @module app/lib/dataIntelligence/semantic/agenticAsk
 */

import { logger } from '@/app/lib/logger';
import { routeQuery, type ChatTurn, type Persona, type RouteResult } from './router';
import { tryCacheLayers, type CacheResult, type ScorecardReader } from './cacheRouter';
import { executeQueryPlan, type ExecuteResult, type SqlRunner } from './sqlCompiler';
import type { QueryPlan } from './queryPlan';

/** Max antal SQL-iterations før vi giver op (Adfærd 2 i ticket) */
const MAX_SQL_ATTEMPTS = 2;

/** Output fra én iteration — hjælper testbarhed */
export interface AgenticTrace {
  /** Hvilket lag svaret kom fra */
  source: 'cache' | 'semantic' | 'clarify' | 'decline' | 'fallback' | 'failed';
  /** Hvilket cache-lag hvis source=cache */
  cacheLayer?: 'scorecard' | 'mv' | 'redis';
  /** Antal SQL-iterations brugt */
  sqlAttempts: number;
  /** Persona detekteret af router */
  persona?: Persona;
  /** Total tid i ms */
  totalMs: number;
  /** Per-step warnings/errors */
  warnings: string[];
}

/** Det færdige resultat returneret til caller */
export type AgenticResult =
  | {
      kind: 'data';
      /** Cache-resultat (skalar eller tabel) eller compiler-output */
      data: CacheResult | (ExecuteResult & { layer: 'semantic' });
      /** Plan der blev brugt — null hvis cache-svar uden plan-rewrite */
      plan: QueryPlan;
      trace: AgenticTrace;
    }
  | {
      kind: 'clarify';
      message: string;
      alternatives: Array<{ description: string; plan: QueryPlan }>;
      trace: AgenticTrace;
    }
  | {
      kind: 'decline';
      reason: string;
      trace: AgenticTrace;
    }
  | {
      kind: 'failed';
      reason: string;
      lastSql?: string;
      trace: AgenticTrace;
    };

/** Input til orchestratoren */
export interface AgenticAskOptions {
  /** Tidligere turns i samme session (for kontekst) */
  history?: ChatTurn[];
  /** Manual persona override (ellers detect) */
  personaOverride?: Persona;
  /** Claude API-nøgle (default = env) */
  claudeKey?: string;
  /** SQL-runner (default = createDefaultSqlRunner) */
  sqlRunner: SqlRunner;
  /** Reader til scorecard-tabellen (optional — uden = skip cache) */
  scorecardReader?: ScorecardReader;
  /** Reference-tid (default = i dag) — testbarhed */
  now?: Date;
  /** Skip Redis-lag (fx i tests) */
  skipRedis?: boolean;
}

/**
 * Hovedfunktion. Ansvarlig for at:
 *   1. Route NL → plan via L2.2
 *   2. Forsøg cache-hit (scorecard/mv/redis)
 *   3. Compile + execute via L2.3
 *   4. Retry hvis 0 rows (relax plan)
 *
 * @param question - Bruger-spørgsmål (dansk)
 * @param options - Konfiguration + runtime-deps
 * @returns Typed result (data | clarify | decline | failed)
 */
export async function agenticAsk(
  question: string,
  options: AgenticAskOptions
): Promise<AgenticResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const now = options.now ?? new Date();

  // ── 1. Route NL → plan ────────────────────────────────────────────────
  let routed: RouteResult;
  try {
    routed = await routeQuery(question, {
      history: options.history,
      personaOverride: options.personaOverride,
      apiKey: options.claudeKey,
    });
  } catch (err) {
    logger.error('[agenticAsk] router fejl:', err);
    return {
      kind: 'failed',
      reason: 'Router-fejl',
      trace: {
        source: 'failed',
        sqlAttempts: 0,
        totalMs: Date.now() - startedAt,
        warnings,
      },
    };
  }

  // Router returnerede clarify/fallback — videregiv direkte
  if (routed.kind === 'needs_clarification') {
    return {
      kind: 'clarify',
      message: routed.message,
      alternatives: routed.alternatives,
      trace: {
        source: 'clarify',
        sqlAttempts: 0,
        totalMs: Date.now() - startedAt,
        warnings,
      },
    };
  }
  if (routed.kind === 'fallback_to_generative') {
    return {
      kind: 'decline',
      reason: routed.reason,
      trace: {
        source: 'decline',
        sqlAttempts: 0,
        totalMs: Date.now() - startedAt,
        warnings,
      },
    };
  }

  // Plan er klar
  const plan = routed.plan;
  const persona = routed.persona;

  // ── 2. Forsøg cache ──────────────────────────────────────────────────
  const cacheHit = await tryCacheLayers(plan, {
    scorecardReader: options.scorecardReader,
    now,
    skipRedis: options.skipRedis,
  });
  if (cacheHit) {
    return {
      kind: 'data',
      data: cacheHit,
      plan,
      trace: {
        source: 'cache',
        cacheLayer: cacheHit.layer,
        sqlAttempts: 0,
        persona,
        totalMs: Date.now() - startedAt,
        warnings,
      },
    };
  }

  // ── 3. Compile + execute (med retry-on-empty) ─────────────────────────
  let attempts = 0;
  let lastSql: string | undefined;
  let lastError: string | undefined;
  let currentPlan = plan;

  while (attempts < MAX_SQL_ATTEMPTS) {
    attempts++;
    try {
      const exec = await executeQueryPlan(currentPlan, options.sqlRunner, { now });
      lastSql = exec.sql;

      if (exec.rows.length === 0 && attempts < MAX_SQL_ATTEMPTS) {
        // Relax: drop time-range (typisk for-restriktivt) eller fjern ét filter
        const relaxed = relaxPlan(currentPlan);
        if (relaxed) {
          warnings.push(`0 rows — relakserer plan (iteration ${attempts}/${MAX_SQL_ATTEMPTS})`);
          currentPlan = relaxed;
          continue;
        }
      }

      return {
        kind: 'data',
        data: { ...exec, layer: 'semantic' as const },
        plan: currentPlan,
        trace: {
          source: 'semantic',
          sqlAttempts: attempts,
          persona,
          totalMs: Date.now() - startedAt,
          warnings,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'unknown error';
      warnings.push(`SQL fejl (iteration ${attempts}): ${lastError}`);
      // Ved compile/execute-fejl giver retry-loop ikke mening pt
      // (vi har ikke en self-correction-kanal til Claude i denne fase).
      break;
    }
  }

  return {
    kind: 'failed',
    reason: lastError ?? `0 rows efter ${MAX_SQL_ATTEMPTS} forsøg`,
    lastSql,
    trace: {
      source: 'failed',
      sqlAttempts: attempts,
      persona,
      totalMs: Date.now() - startedAt,
      warnings,
    },
  };
}

/**
 * Forsøg at relaxe en plan der returnerede 0 rows. Strategi:
 *   1. Hvis timeRange — fjern den (tids-filter er den hyppigste årsag til 0)
 *   2. Ellers hvis ≥1 bruger-filter — drop sidste filter
 *   3. Ellers null (kan ikke relaxe)
 *
 * @param plan - Original plan
 * @returns Relakset plan eller null hvis ingen relax-mulighed
 */
export function relaxPlan(plan: QueryPlan): QueryPlan | null {
  if (plan.timeRange) {
    const { timeRange: _timeRange, ...rest } = plan;
    return { ...rest };
  }
  if (plan.filters.length > 0) {
    return {
      ...plan,
      filters: plan.filters.slice(0, -1),
    };
  }
  return null;
}
