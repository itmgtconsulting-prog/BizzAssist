/**
 * Knowledge Cache Builder — BIZZ-1419 (Fase 2, Lag 2)
 *
 * Orchestrerer alle topic-builders og upsert'er resultaterne til
 * dataintel.analytics_knowledge. Fejl i én topic stopper ikke andre.
 *
 * @module app/lib/dataIntelligence/buildKnowledge
 */

import { logger } from '@/app/lib/logger';
import { createDefaultSqlRunner, type SqlRunner } from './buildCatalog';
import { ALL_TOPICS, type KnowledgeRow } from './topics';

/** Escape single-quotes for SQL string-literals. */
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/** Format JSONB-literal eller NULL. */
function jsonbLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  return `'${sqlEscape(JSON.stringify(v))}'::jsonb`;
}

/** Format text-literal eller NULL. */
function textLiteral(v: string | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  return `'${sqlEscape(v)}'`;
}

/**
 * Slet alle rækker for en given topic og insert nye.
 * Atomic per-topic: vi venter med at slette indtil builderen er færdig
 * for at undgå tomme intervaller.
 */
async function upsertTopic(rpc: SqlRunner, topic: string, rows: KnowledgeRow[]): Promise<void> {
  if (rows.length === 0) {
    // Slet eksisterende men insert intet (topic produced no rows denne gang)
    await rpc(`DELETE FROM dataintel.analytics_knowledge WHERE topic = '${sqlEscape(topic)}'`);
    return;
  }

  const values = rows
    .map(
      (r) =>
        `(${textLiteral(r.topic)}, ${textLiteral(r.topic_label_da)}, ${jsonbLiteral(r.key)}, ${jsonbLiteral(r.value)}, ${textLiteral(r.source_query)}, now(), ${r.expires_at ? textLiteral(r.expires_at) : 'NULL'})`
    )
    .join(',\n');

  // Atomic: slet + insert i én transaktion
  const sql = `
    BEGIN;
    DELETE FROM dataintel.analytics_knowledge WHERE topic = '${sqlEscape(topic)}';
    INSERT INTO dataintel.analytics_knowledge (topic, topic_label_da, key, value, source_query, computed_at, expires_at) VALUES ${values};
    COMMIT;
  `;
  await rpc(sql);
}

/**
 * Bygger og upsert'er alle topics. Returnerer per-topic summary.
 */
export async function buildAndUpsertKnowledge(rpc?: SqlRunner): Promise<{
  results: Array<{ topic: string; rows: number; durationMs: number; error?: string }>;
}> {
  const runner = rpc ?? createDefaultSqlRunner();
  const results: Array<{ topic: string; rows: number; durationMs: number; error?: string }> = [];

  // Kør alle topics sekventielt — gør debug nemmere og holder DB-load lavt.
  // Hver topic er sekvensspecifik; intet behov for parallelisme.
  for (const { name, build } of ALL_TOPICS) {
    const start = Date.now();
    try {
      const rows = await build(runner);
      await upsertTopic(runner, name, rows);
      results.push({ topic: name, rows: rows.length, durationMs: Date.now() - start });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[buildKnowledge] ${name} failed:`, msg);
      results.push({ topic: name, rows: 0, durationMs: Date.now() - start, error: msg });
    }
  }

  return { results };
}
