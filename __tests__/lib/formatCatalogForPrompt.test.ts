/**
 * Unit tests for app/lib/dataIntelligence/formatCatalogForPrompt.ts (BIZZ-1409).
 */
import { describe, it, expect } from 'vitest';
import { formatCatalogForPrompt } from '@/app/lib/dataIntelligence/formatCatalogForPrompt';
import type { CatalogRow } from '@/app/lib/dataIntelligence/buildCatalog';

describe('formatCatalogForPrompt', () => {
  it('returnerer placeholder ved tom catalog', () => {
    const out = formatCatalogForPrompt([]);
    expect(out).toContain('Catalog tomt');
  });

  it('formaterer tabel-niveau row + kolonner', () => {
    const rows: CatalogRow[] = [
      {
        table_schema: 'public',
        table_name: 'cvr_virksomhed',
        column_name: '',
        data_type: null,
        row_count: 2_100_000,
        null_count: null,
        distinct_count: null,
        top_values: null,
        min_value: null,
        max_value: null,
        semantic_label: null,
        pii_flag: false,
      },
      {
        table_schema: 'public',
        table_name: 'cvr_virksomhed',
        column_name: 'status',
        data_type: 'text',
        row_count: null,
        null_count: 0,
        distinct_count: 4,
        top_values: [
          { value: 'NORMAL', freq: 0.78 },
          { value: 'OPHØRT', freq: 0.19 },
          { value: 'UNDER_KONKURS', freq: 0.03 },
        ],
        min_value: null,
        max_value: null,
        semantic_label: null,
        pii_flag: false,
      },
    ];

    const out = formatCatalogForPrompt(rows, '2026-05-14');

    expect(out).toContain('## Datakatalog (opdateret 2026-05-14)');
    expect(out).toContain('### public.cvr_virksomhed (2.1M rækker)');
    expect(out).toContain('- status (text');
    expect(out).toContain('NORMAL 78%');
    expect(out).toContain('OPHØRT 19%');
  });

  it('skjuler top-værdier for PII-kolonner', () => {
    const rows: CatalogRow[] = [
      {
        table_schema: 'public',
        table_name: 'ejf_ejerskab',
        column_name: '',
        data_type: null,
        row_count: 7_600_000,
        null_count: null,
        distinct_count: null,
        top_values: null,
        min_value: null,
        max_value: null,
        semantic_label: null,
        pii_flag: false,
      },
      {
        table_schema: 'public',
        table_name: 'ejf_ejerskab',
        column_name: 'ejer_navn',
        data_type: 'text',
        row_count: null,
        null_count: 0,
        distinct_count: 4_200_000,
        top_values: null, // PII → no top values
        min_value: null,
        max_value: null,
        semantic_label: null,
        pii_flag: true,
      },
    ];

    const out = formatCatalogForPrompt(rows, '2026-05-14');
    expect(out).toContain('ejer_navn');
    expect(out).toContain('PII, top-værdier udeladt');
  });

  it('inkluderer semantic_label hvis tilstede', () => {
    const rows: CatalogRow[] = [
      {
        table_schema: 'public',
        table_name: 'cvr_virksomhed',
        column_name: '',
        data_type: null,
        row_count: 2_100_000,
        null_count: null,
        distinct_count: null,
        top_values: null,
        min_value: null,
        max_value: null,
        semantic_label: null,
        pii_flag: false,
      },
      {
        table_schema: 'public',
        table_name: 'cvr_virksomhed',
        column_name: 'kommune_kode',
        data_type: 'smallint',
        row_count: null,
        null_count: 42000,
        distinct_count: 98,
        top_values: [{ value: '101', freq: 0.15 }],
        min_value: '101',
        max_value: '851',
        semantic_label: 'kommunekode',
        pii_flag: false,
      },
    ];

    const out = formatCatalogForPrompt(rows, '2026-05-14');
    expect(out).toContain('[kommunekode]');
  });
});
