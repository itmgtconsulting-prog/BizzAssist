/**
 * formatCatalogForPrompt — BIZZ-1409 (Fase 1, Lag 1)
 *
 * Formaterer indholdet af dataintel.data_catalog som kompakt Markdown
 * der kan injiceres i AI system prompt. Budget: ~2.500 tokens for hele
 * whitelisten.
 *
 * Output-eksempel:
 *
 *   ### cvr_virksomhed (2.1M rækker)
 *   - status (text, 0% null, top: NORMAL 78%, OPHØRT 19%)
 *   - kommune_kode (smallint, 2% null, top: 101, 751, 461)
 *
 * @module app/lib/dataIntelligence/formatCatalogForPrompt
 */

import type { CatalogRow } from './buildCatalog';

/** Max antal tokens — approx (4 chars per token) for guard. */
const MAX_TOKEN_BUDGET = 3000;
const APPROX_CHARS_PER_TOKEN = 4;

/** Format et rækketal kort: 2.5M, 142k, 98. */
function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/** Format en procent kort: "2%", "0%", "<1%". */
function formatPct(part: number | null, whole: number | null): string {
  if (part === null || part === undefined || whole === null || whole === undefined || whole === 0) {
    return '?';
  }
  const pct = (part / whole) * 100;
  if (pct < 0.1) return '0%';
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

/** Trim og format top-3 mest-hyppige værdier som "A 78%, B 19%, C 3%". */
function formatTopValues(
  topValues: Array<{ value: string; freq: number }> | null | undefined
): string {
  if (!topValues || topValues.length === 0) return '';
  const top = topValues.slice(0, 3);
  return top
    .map((v) => {
      const pct = Math.round(v.freq * 100);
      if (pct >= 5) {
        return `${v.value} ${pct}%`;
      }
      return v.value;
    })
    .join(', ');
}

/** Format én kolonne-række som bullet. */
function formatColumnRow(col: CatalogRow, rowCount: number): string {
  const parts: string[] = [];
  parts.push(col.column_name);

  const meta: string[] = [];
  if (col.data_type) meta.push(col.data_type);
  if (col.null_count !== null && col.null_count !== undefined) {
    meta.push(`${formatPct(col.null_count, rowCount)} null`);
  }
  if (col.distinct_count !== null && col.distinct_count !== undefined) {
    if (col.distinct_count <= 50) {
      meta.push(`${col.distinct_count} distinct`);
    }
  }

  let line = `- ${col.column_name}`;
  if (meta.length > 0) {
    line += ` (${meta.join(', ')})`;
  }

  const top = formatTopValues(col.top_values);
  if (top) {
    line += ` — top: ${top}`;
  } else if (col.pii_flag) {
    line += ' — [PII, top-værdier udeladt]';
  } else if (col.min_value && col.max_value && col.min_value !== col.max_value) {
    line += ` — range: ${col.min_value} … ${col.max_value}`;
  }

  if (col.semantic_label) {
    line += ` [${col.semantic_label}]`;
  }

  return line;
}

/** Gruppe-output for én tabel. */
function formatTable(tableRow: CatalogRow, columnRows: CatalogRow[]): string {
  const lines: string[] = [];
  const fqName = `${tableRow.table_schema}.${tableRow.table_name}`;
  lines.push(`### ${fqName} (${formatCount(tableRow.row_count)} rækker)`);
  const rowCount = tableRow.row_count ?? 0;
  for (const c of columnRows) {
    lines.push(formatColumnRow(c, rowCount));
  }
  return lines.join('\n');
}

/**
 * Formaterer hele catalog-resultat som Markdown.
 *
 * @param rows Alle rækker fra dataintel.data_catalog
 * @param computedAt Optional explicit timestamp; ellers tages fra første row
 * @returns Markdown-tekst klar til injection i system prompt
 */
export function formatCatalogForPrompt(rows: CatalogRow[], computedAt?: string): string {
  if (rows.length === 0) {
    return '## Datakatalog\n\n_(Catalog tomt — venter på første cron-kørsel.)_';
  }

  // Group by table
  const byTable = new Map<string, { tableRow?: CatalogRow; columns: CatalogRow[] }>();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`;
    let group = byTable.get(key);
    if (!group) {
      group = { columns: [] };
      byTable.set(key, group);
    }
    if (r.column_name === '') {
      group.tableRow = r;
    } else {
      group.columns.push(r);
    }
  }

  const ts =
    computedAt ??
    (rows.find((r) => r.computed_at_iso)?.computed_at_iso as string | undefined) ??
    '';
  const header = ts ? `## Datakatalog (opdateret ${ts})` : '## Datakatalog';

  const sections: string[] = [header, ''];
  sections.push(
    '_Pre-beregnet metadata om vores datasæt. Brug det til at vide hvilke kolonner der findes, hvor mange null-værdier de har, og hvad de mest hyppige værdier er — uden at lave forespørgsler._',
    ''
  );

  for (const [, group] of byTable) {
    if (!group.tableRow) continue;
    sections.push(formatTable(group.tableRow, group.columns));
    sections.push('');
  }

  let result = sections.join('\n');

  // Token-budget guard
  const approxTokens = Math.ceil(result.length / APPROX_CHARS_PER_TOKEN);
  if (approxTokens > MAX_TOKEN_BUDGET) {
    const maxChars = MAX_TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN;
    result =
      result.slice(0, maxChars) +
      '\n\n_(Catalog afkortet til budget; resterende tabeller udeladt.)_';
  }

  return result;
}

// Tilføj computed_at_iso til typen lokalt for at undgå at ændre CatalogRow
declare module './buildCatalog' {
  interface CatalogRow {
    computed_at_iso?: string;
  }
}
