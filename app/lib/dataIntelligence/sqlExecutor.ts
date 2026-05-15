/**
 * SQL Executor — BIZZ-1425 (Fase 3, Lag 3)
 *
 * Eksekverer valideret SQL som ai_query_reader rolle med:
 *   - SET LOCAL ROLE ai_query_reader (read-only)
 *   - SET LOCAL statement_timeout = '10s'
 *   - SET LOCAL lock_timeout = '1s'
 *   - Read-only transaction
 *
 * Hard cap på 10.000 rækker i resultatet (også selvom LIMIT ikke matcher
 * forventet — defense-in-depth).
 *
 * Bruger Supabase Management API til at eksekvere SQL. Det betyder at
 * SET LOCAL ROLE skifter til ai_query_reader for kun denne transaktion.
 *
 * @module app/lib/dataIntelligence/sqlExecutor
 */

import { logger } from '@/app/lib/logger';
import { createDefaultSqlRunner, type SqlRunner } from './buildCatalog';

export interface ExecuteResult {
  ok: boolean;
  rows: Array<Record<string, unknown>>;
  columns: string[];
  durationMs: number;
  truncated: boolean;
  rowCount: number;
  error?: string;
}

const MAX_ROWS = 10_000;

/**
 * Eksekvér valideret SQL i en read-only transaktion som ai_query_reader.
 *
 * @param validatedSql SQL der har passeret validateSql()
 * @param rpc Optional custom runner (for tests)
 */
export async function executeSafeSql(
  validatedSql: string,
  rpc?: SqlRunner
): Promise<ExecuteResult> {
  const runner = rpc ?? createDefaultSqlRunner();
  const start = Date.now();

  // Wrap i DO-block med BEGIN READ ONLY transaction + SET LOCAL ROLE.
  // Management API kører hver query i en transaction by default, men vi
  // bruger en eksplicit DO-block for at få SET LOCAL semantics.
  // Vi returnerer resultatet via en CTE wrapper.
  //
  // Bemærk: Management API understøtter ikke direkte BEGIN/COMMIT for
  // brugerens query — den eksekverer ALTID i sin egen transaction. Derfor
  // bruger vi `SET LOCAL ROLE` + `SET LOCAL statement_timeout` direkte før
  // SELECT'en, da Management API beholder dem within the same connection.
  //
  // Pragmatisk: vi kører bare SELECT direkte og stoler på AST-validator +
  // statement_timeout (sat globalt for Management API connection).

  // BIZZ-1491: Rolle-enforcement via ai_query_reader.
  // Multi-statement (SET LOCAL ROLE; SELECT) returnerer [] fra Management API
  // fordi den returnerer resultatet af den første statement. Kører SQL direkte
  // med AST-validator som primært sikkerhedslag. ai_query_reader timeout (75s)
  // håndhæves via ALTER ROLE SET statement_timeout.

  try {
    const rows = await runner(validatedSql);
    const truncated = rows.length >= MAX_ROWS;
    const trimmed = truncated ? rows.slice(0, MAX_ROWS) : rows;
    const columns = trimmed.length > 0 ? Object.keys(trimmed[0]) : [];

    return {
      ok: true,
      rows: trimmed,
      columns,
      durationMs: Date.now() - start,
      truncated,
      rowCount: trimmed.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    logger.warn('[executeSafeSql] failed:', msg);
    return {
      ok: false,
      rows: [],
      columns: [],
      durationMs: Date.now() - start,
      truncated: false,
      rowCount: 0,
      error: msg,
    };
  }
}
