/**
 * fetchCatalog — BIZZ-1410 (Fase 1, Lag 1)
 *
 * Henter dataintel.data_catalog rows fra databasen via Supabase Management API.
 * Bruges af AI chat + analyse/query til at injicere data catalog i system prompt.
 *
 * Resultatet caches in-memory i 5 min (cache TTL = nightly refresh er typisk
 * den eneste ændring; 5 min er passende for at undgå roundtrips).
 *
 * @module app/lib/dataIntelligence/fetchCatalog
 */

import { logger } from '@/app/lib/logger';
import { createDefaultSqlRunner, type CatalogRow } from './buildCatalog';

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { rows: CatalogRow[]; computedAt: string | null; expiresAt: number } | null = null;

/** Reset cache (anvendt af tests). */
export function _resetCatalogCache(): void {
  cached = null;
}

/**
 * Henter catalog-rækker. Cached i 5 min. Returnerer tom array ved fejl
 * (graceful degradation — AI fortsætter uden catalog).
 */
export async function fetchCatalog(): Promise<{
  rows: CatalogRow[];
  computedAt: string | null;
}> {
  if (cached && cached.expiresAt > Date.now()) {
    return { rows: cached.rows, computedAt: cached.computedAt };
  }

  try {
    const rpc = createDefaultSqlRunner();
    const sql = `SELECT table_schema, table_name, column_name, data_type, row_count, null_count, distinct_count, top_values, min_value, max_value, semantic_label, pii_flag, computed_at::text AS computed_at_iso FROM dataintel.data_catalog ORDER BY table_schema, table_name, column_name`;
    const rows = await rpc(sql);
    const typed = rows as unknown as CatalogRow[];
    const computedAt = typed.length > 0 ? (typed[0].computed_at_iso ?? null) : null;
    cached = {
      rows: typed,
      computedAt,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    return { rows: typed, computedAt };
  } catch (err) {
    logger.warn('[fetchCatalog] failed — returning empty catalog:', err);
    return { rows: [], computedAt: null };
  }
}
