/**
 * Unit tests for app/lib/dataIntelligence/buildCatalog.ts (BIZZ-1407).
 *
 * Dækker:
 *   - parsePgArray: håndterer NULL, tomme arrays, quoted strings, tal
 *   - buildCatalogForTable: bygger korrekte rows fra mock pg_stats
 *   - PII-kolonner: top_values genereres ikke
 *   - n_distinct negativ (fraktion) → korrekt distinct_count beregning
 *   - rowCount=0 → null_count forbliver null
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parsePgArray,
  buildCatalogForTable,
  CATALOG_TABLES,
  type SqlRunner,
} from '@/app/lib/dataIntelligence/buildCatalog';

describe('parsePgArray', () => {
  it('returnerer tom array for null input', () => {
    expect(parsePgArray(null)).toEqual([]);
  });

  it('returnerer tom array for "NULL" string', () => {
    expect(parsePgArray('NULL')).toEqual([]);
  });

  it('returnerer tom array for "{}" tom array', () => {
    expect(parsePgArray('{}')).toEqual([]);
  });

  it('parser tal-array', () => {
    expect(parsePgArray('{1,2,3}')).toEqual(['1', '2', '3']);
  });

  it('parser quoted strings', () => {
    expect(parsePgArray('{"NORMAL","OPHØRT","UNDER_KONKURS"}')).toEqual([
      'NORMAL',
      'OPHØRT',
      'UNDER_KONKURS',
    ]);
  });

  it('parser mixed unquoted (tal) + quoted (string)', () => {
    expect(parsePgArray('{101,"København",751}')).toEqual(['101', 'København', '751']);
  });

  it('returnerer tom array for malformed input', () => {
    expect(parsePgArray('not an array')).toEqual([]);
  });
});

describe('buildCatalogForTable', () => {
  /** Mock SqlRunner der returnerer foruddefinerede resultater per match. */
  function mockRunner(responses: Record<string, Array<Record<string, unknown>>>): SqlRunner {
    return vi.fn(async (sql: string) => {
      for (const [key, val] of Object.entries(responses)) {
        if (sql.includes(key)) return val;
      }
      return [];
    });
  }

  it('producerer table-niveau row + per-kolonne rows', async () => {
    const spec = CATALOG_TABLES.find((t) => t.table === 'kommune_ref')!;
    const rpc = mockRunner({
      pg_class: [{ n: 98 }],
      'information_schema.columns': [
        { column_name: 'kommune_kode', data_type: 'smallint' },
        { column_name: 'kommunenavn', data_type: 'text' },
        { column_name: 'region', data_type: 'text' },
      ],
      pg_stats: [
        {
          attname: 'kommune_kode',
          null_frac: 0,
          n_distinct: 98,
          most_common_vals: null,
          most_common_freqs: null,
          histogram_bounds: '{101,851}',
        },
        {
          attname: 'region',
          null_frac: 0,
          n_distinct: 5,
          most_common_vals: '{Hovedstaden,Midtjylland,Syddanmark,Sjælland,Nordjylland}',
          most_common_freqs: '{0.30,0.22,0.20,0.18,0.10}',
          histogram_bounds: null,
        },
      ],
    });

    const rows = await buildCatalogForTable(rpc, spec);

    // 1 tabel-niveau + 3 kolonner
    expect(rows).toHaveLength(4);

    const tableRow = rows.find((r) => r.column_name === '');
    expect(tableRow?.row_count).toBe(98);
    expect(tableRow?.pii_flag).toBe(false);

    const region = rows.find((r) => r.column_name === 'region');
    expect(region?.data_type).toBe('text');
    expect(region?.distinct_count).toBe(5);
    expect(region?.top_values).toEqual([
      { value: 'Hovedstaden', freq: 0.3 },
      { value: 'Midtjylland', freq: 0.22 },
      { value: 'Syddanmark', freq: 0.2 },
      { value: 'Sjælland', freq: 0.18 },
      { value: 'Nordjylland', freq: 0.1 },
    ]);

    const kommune = rows.find((r) => r.column_name === 'kommune_kode');
    expect(kommune?.min_value).toBe('101');
    expect(kommune?.max_value).toBe('851');
    // kommune_ref har ingen semanticLabels defineret; semantic_label er null
    expect(kommune?.semantic_label).toBeNull();
  });

  it('PII-kolonner får ikke top_values selv hvis pg_stats har dem', async () => {
    const spec = CATALOG_TABLES.find((t) => t.table === 'cvr_virksomhed_ejerskab')!;
    // Trigger ved at sætte ejer_navn (som er i piiColumns) i columns midlertidigt
    const specWithPii = { ...spec, columns: [...spec.columns, 'ejer_navn'] };
    const rpc = mockRunner({
      pg_class: [{ n: 333000 }],
      'information_schema.columns': [{ column_name: 'ejer_navn', data_type: 'text' }],
      pg_stats: [
        {
          attname: 'ejer_navn',
          null_frac: 0,
          n_distinct: -0.9,
          most_common_vals: '{"Hans Hansen","Jens Jensen"}',
          most_common_freqs: '{0.001,0.0008}',
          histogram_bounds: null,
        },
      ],
    });

    const rows = await buildCatalogForTable(rpc, specWithPii);
    const ejerNavn = rows.find((r) => r.column_name === 'ejer_navn');
    expect(ejerNavn?.pii_flag).toBe(true);
    expect(ejerNavn?.top_values).toBeNull();
  });

  it('konverterer negativ n_distinct til absolut count via rowCount', async () => {
    const spec = CATALOG_TABLES.find((t) => t.table === 'cvr_virksomhed')!;
    const rpc = mockRunner({
      pg_class: [{ n: 2_000_000 }],
      'information_schema.columns': [{ column_name: 'status', data_type: 'text' }],
      pg_stats: [
        {
          attname: 'status',
          null_frac: 0,
          // -0.000002 = ca. 4 distinct ud af 2M
          n_distinct: -0.000002,
          most_common_vals: '{NORMAL,OPHØRT}',
          most_common_freqs: '{0.78,0.19}',
          histogram_bounds: null,
        },
      ],
    });

    const rows = await buildCatalogForTable(rpc, { ...spec, columns: ['status'] });
    const statusRow = rows.find((r) => r.column_name === 'status');
    expect(statusRow?.distinct_count).toBe(4);
  });

  it('returnerer null null_count når rowCount=0', async () => {
    const spec = CATALOG_TABLES.find((t) => t.table === 'kommune_ref')!;
    const rpc = mockRunner({
      pg_class: [{ n: 0 }],
      'information_schema.columns': [{ column_name: 'kommune_kode', data_type: 'smallint' }],
      pg_stats: [
        {
          attname: 'kommune_kode',
          null_frac: 0.1,
          n_distinct: 0,
          most_common_vals: null,
          most_common_freqs: null,
          histogram_bounds: null,
        },
      ],
    });

    const rows = await buildCatalogForTable(rpc, { ...spec, columns: ['kommune_kode'] });
    const colRow = rows.find((r) => r.column_name === 'kommune_kode');
    expect(colRow?.null_count).toBeNull();
  });
});
