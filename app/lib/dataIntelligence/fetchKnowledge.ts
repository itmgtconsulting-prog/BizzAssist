/**
 * fetchKnowledge — BIZZ-1420 (Fase 2, Lag 2)
 *
 * Query helper til dataintel.analytics_knowledge. Bruges af AI tool
 * `hent_analytics_knowledge` og af executive summary-injection.
 *
 * @module app/lib/dataIntelligence/fetchKnowledge
 */

import { logger } from '@/app/lib/logger';
import { createDefaultSqlRunner } from './buildCatalog';

export interface KnowledgeFact {
  topic: string;
  topic_label_da: string;
  key: Record<string, unknown>;
  value: Record<string, unknown>;
  computed_at_iso?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let factCache: { facts: KnowledgeFact[]; expiresAt: number } | null = null;

/** Reset cache (tests). */
export function _resetKnowledgeCache(): void {
  factCache = null;
}

/**
 * Henter alle facts for en topic, optionally filtreret med key-match.
 * Returnerer tom array ved fejl.
 */
export async function queryKnowledge(
  topic: string,
  key?: Record<string, unknown>
): Promise<KnowledgeFact[]> {
  try {
    const rpc = createDefaultSqlRunner();
    let sql = `SELECT topic, topic_label_da, key, value, computed_at::text AS computed_at_iso FROM dataintel.analytics_knowledge WHERE topic = '${topic.replace(/'/g, "''")}'`;
    if (key && Object.keys(key).length > 0) {
      const keyJson = JSON.stringify(key).replace(/'/g, "''");
      sql += ` AND key @> '${keyJson}'::jsonb`;
    }
    sql += ` ORDER BY computed_at DESC LIMIT 500`;
    const rows = await rpc(sql);
    return rows as unknown as KnowledgeFact[];
  } catch (err) {
    logger.warn('[fetchKnowledge] failed:', err);
    return [];
  }
}

/**
 * Henter et udvalg af nøgletal til executive summary. Cached 5 min.
 */
export async function fetchExecutiveFacts(): Promise<KnowledgeFact[]> {
  if (factCache && factCache.expiresAt > Date.now()) {
    return factCache.facts;
  }
  try {
    const rpc = createDefaultSqlRunner();
    // Hent 1 række per topic (den globale key={} hvis tilstede)
    const sql = `
      SELECT DISTINCT ON (topic) topic, topic_label_da, key, value, computed_at::text AS computed_at_iso
      FROM dataintel.analytics_knowledge
      WHERE key = '{}'::jsonb
         OR topic IN ('company_status_distribution','data_coverage_bbr','ownership_distribution','temporal_coverage')
      ORDER BY topic, computed_at DESC
    `;
    const rows = await rpc(sql);
    const facts = rows as unknown as KnowledgeFact[];
    factCache = { facts, expiresAt: Date.now() + CACHE_TTL_MS };
    return facts;
  } catch (err) {
    logger.warn('[fetchExecutiveFacts] failed:', err);
    return [];
  }
}

/**
 * Format executive facts som kort tekst-blok til system prompt.
 * Eksempel:
 *   - Virksomheder i alt: 2.087.421 (heraf 1.184.020 aktive)
 *   - BBR-data: 92% af ejendomme har BBR-status
 */
export function formatExecutiveSummary(facts: KnowledgeFact[]): string {
  if (facts.length === 0) return '';
  const lines: string[] = ['## Vores data i tal (executive summary)'];

  for (const f of facts) {
    const v = f.value as Record<string, unknown>;
    if (f.topic === 'company_status_distribution') {
      const total = Number(v.total ?? 0);
      const aktive = Number(v.aktive ?? 0);
      const ophoerte = Number(v.ophoerte ?? 0);
      lines.push(
        `- Virksomheder i alt: ${total.toLocaleString('da-DK')} (heraf ${aktive.toLocaleString('da-DK')} aktive, ${ophoerte.toLocaleString('da-DK')} ophørte)`
      );
    } else if (f.topic === 'data_coverage_bbr') {
      const total = Number(v.total ?? 0);
      const withBbr = Number(v.with_bbr ?? 0);
      if (total > 0) {
        const pct = Math.round((withBbr / total) * 100);
        lines.push(
          `- BBR-data: ${withBbr.toLocaleString('da-DK')} af ${total.toLocaleString('da-DK')} ejendomme har BBR-status (${pct}%)`
        );
      }
    } else if (f.topic === 'ownership_distribution') {
      const aktive = Number(v.aktive_virksomheder ?? 0);
      const medEj = Number(v.med_ejerskab ?? 0);
      if (aktive > 0) {
        const pct = Math.round((medEj / aktive) * 100);
        lines.push(
          `- Ejerskabsdata: ${medEj.toLocaleString('da-DK')} af ${aktive.toLocaleString('da-DK')} aktive virksomheder har CVR-ejerskab (${pct}%)`
        );
      }
    } else if (f.topic === 'temporal_coverage') {
      const k = f.key as { table?: string; column?: string };
      if (k.table === 'cvr_virksomhed' && k.column === 'stiftet') {
        lines.push(`- Ældste virksomhed: stiftet ${v.min ?? '?'}`);
      } else if (k.table === 'ejf_ejerskab' && k.column === 'sidst_opdateret') {
        lines.push(`- Senest opdaterede ejendomsdata: ${String(v.max ?? '?').slice(0, 10)}`);
      }
    }
  }

  if (lines.length === 1) return ''; // Kun header — skip injection
  lines.push('');
  lines.push(
    '_Disse tal opdateres natligt. Brug `hent_analytics_knowledge` tool for detaljer per kommune/branche._'
  );
  return lines.join('\n');
}
