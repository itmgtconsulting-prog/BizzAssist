/**
 * Unit tests for app/lib/search/filterSchema.ts (BIZZ-792 / BIZZ-788a).
 *
 * Verifies URL-query-konvention nail'et af ARCHITECT sign-off:
 *   - Multi-select: komma-separeret
 *   - Range: bindestreg-separeret min-max
 *   - Toggle: boolean, default udelades fra URL
 *   - Dropdown: enkelt værdi
 *   - Invalid values rejectes silent (returnerer undefined, crasher ikke)
 */
import { describe, it, expect } from 'vitest';
import {
  encodeFilterValue,
  decodeFilterValue,
  parseFiltersFromSearchParams,
  serializeFiltersToSearchParams,
  resetFilters,
  type MultiSelectFilterSchema,
  type DropdownFilterSchema,
  type RangeFilterSchema,
  type ToggleFilterSchema,
  type FilterSchema,
} from '@/app/lib/search/filterSchema';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const multiSelect: MultiSelectFilterSchema = {
  type: 'multi-select',
  key: 'ejendomstype',
  label: 'Ejendomstype',
  options: [
    { value: 'parcelhus', label: 'Parcelhus' },
    { value: 'raekkehus', label: 'Rækkehus' },
    { value: 'lejlighed', label: 'Lejlighed' },
  ],
};

const dropdown: DropdownFilterSchema = {
  type: 'dropdown',
  key: 'energimaerke',
  label: 'Energimærke',
  options: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ],
};

const range: RangeFilterSchema = {
  type: 'range',
  key: 'areal',
  label: 'Areal',
  min: 0,
  max: 1000,
  unit: 'm²',
};

const toggle: ToggleFilterSchema = {
  type: 'toggle',
  key: 'skjulUdfasede',
  label: 'Skjul udfasede',
  default: true,
};

const allSchemas: FilterSchema[] = [multiSelect, dropdown, range, toggle];

// ─── encodeFilterValue ─────────────────────────────────────────────────────

describe('encodeFilterValue', () => {
  it('multi-select: joins array with comma', () => {
    expect(encodeFilterValue(multiSelect, ['parcelhus', 'lejlighed'])).toBe('parcelhus,lejlighed');
  });
  it('multi-select: returns null for empty array', () => {
    expect(encodeFilterValue(multiSelect, [])).toBeNull();
  });
  it('dropdown: returns value unchanged', () => {
    expect(encodeFilterValue(dropdown, 'a')).toBe('a');
  });
  it('dropdown: returns null for empty string', () => {
    expect(encodeFilterValue(dropdown, '')).toBeNull();
  });
  it('range: encodes min-max with hyphen', () => {
    expect(encodeFilterValue(range, { min: 50, max: 150 })).toBe('50-150');
  });
  it('range: fills in schema.min/max when only one side set', () => {
    expect(encodeFilterValue(range, { min: 50 })).toBe('50-1000');
    expect(encodeFilterValue(range, { max: 150 })).toBe('0-150');
  });
  it('range: returns null when both sides undefined', () => {
    expect(encodeFilterValue(range, {})).toBeNull();
  });
  it('toggle: omits default value from URL', () => {
    expect(encodeFilterValue(toggle, true)).toBeNull(); // default=true
    expect(encodeFilterValue(toggle, false)).toBe('false');
  });
});

// ─── decodeFilterValue ─────────────────────────────────────────────────────

describe('decodeFilterValue', () => {
  it('multi-select: splits comma-separated string, filters unknown values', () => {
    expect(decodeFilterValue(multiSelect, 'parcelhus,lejlighed')).toEqual([
      'parcelhus',
      'lejlighed',
    ]);
    // Unknown "ukendt" is filtered out silently
    expect(decodeFilterValue(multiSelect, 'parcelhus,ukendt,lejlighed')).toEqual([
      'parcelhus',
      'lejlighed',
    ]);
  });
  it('multi-select: returns undefined for empty or all-invalid input', () => {
    expect(decodeFilterValue(multiSelect, '')).toBeUndefined();
    expect(decodeFilterValue(multiSelect, 'ukendt,andet')).toBeUndefined();
    expect(decodeFilterValue(multiSelect, null)).toBeUndefined();
  });
  it('dropdown: accepts known values', () => {
    expect(decodeFilterValue(dropdown, 'a')).toBe('a');
  });
  it('dropdown: rejects unknown values', () => {
    expect(decodeFilterValue(dropdown, 'z')).toBeUndefined();
  });
  it('range: parses "50-150" into {min,max}', () => {
    expect(decodeFilterValue(range, '50-150')).toEqual({ min: 50, max: 150 });
  });
  it('range: supports open-ended "50-"', () => {
    expect(decodeFilterValue(range, '50-')).toEqual({ min: 50 });
  });
  it('range: supports "-150"', () => {
    expect(decodeFilterValue(range, '-150')).toEqual({ max: 150 });
  });
  it('range: clamps out-of-bounds values', () => {
    // min=-10 (below schema.min=0) → filtered; max=2000 (above 1000) → filtered
    expect(decodeFilterValue(range, '-2000')).toBeUndefined();
  });
  it('range: rejects malformed input', () => {
    expect(decodeFilterValue(range, 'abc')).toBeUndefined();
    expect(decodeFilterValue(range, '-')).toBeUndefined();
    expect(decodeFilterValue(range, '50-100-200')).toBeUndefined();
  });
  it('toggle: parses "true"/"false"', () => {
    expect(decodeFilterValue(toggle, 'true')).toBe(true);
    expect(decodeFilterValue(toggle, 'false')).toBe(false);
    expect(decodeFilterValue(toggle, 'maybe')).toBeUndefined();
  });
});

// ─── parseFiltersFromSearchParams ──────────────────────────────────────────

describe('parseFiltersFromSearchParams', () => {
  it('parses complete URL into state', () => {
    const params = new URLSearchParams(
      'ejendomstype=parcelhus,lejlighed&energimaerke=a&areal=50-150&skjulUdfasede=false'
    );
    expect(parseFiltersFromSearchParams(allSchemas, params)).toEqual({
      ejendomstype: ['parcelhus', 'lejlighed'],
      energimaerke: 'a',
      areal: { min: 50, max: 150 },
      skjulUdfasede: false,
    });
  });
  it('fills in toggle default when URL param missing', () => {
    const params = new URLSearchParams('');
    expect(parseFiltersFromSearchParams(allSchemas, params)).toEqual({
      skjulUdfasede: true, // default
    });
  });
  it('silently drops invalid values instead of crashing', () => {
    const params = new URLSearchParams('ejendomstype=ukendt&areal=abc&skjulUdfasede=maybe');
    // ejendomstype: all-invalid → undefined → skipped
    // areal: malformed → skipped
    // skjulUdfasede: invalid string → default fallback
    expect(parseFiltersFromSearchParams(allSchemas, params)).toEqual({
      skjulUdfasede: true, // default because invalid raw fell through
    });
  });
});

// ─── serializeFiltersToSearchParams ────────────────────────────────────────

describe('serializeFiltersToSearchParams', () => {
  it('serializes state back to URL params', () => {
    const state = {
      ejendomstype: ['parcelhus'],
      energimaerke: 'a',
      areal: { min: 50, max: 150 },
      skjulUdfasede: false,
    };
    const params = serializeFiltersToSearchParams(allSchemas, state);
    expect(params.get('ejendomstype')).toBe('parcelhus');
    expect(params.get('energimaerke')).toBe('a');
    expect(params.get('areal')).toBe('50-150');
    expect(params.get('skjulUdfasede')).toBe('false');
  });
  it('omits default toggle values from URL', () => {
    const params = serializeFiltersToSearchParams(allSchemas, { skjulUdfasede: true });
    expect(params.has('skjulUdfasede')).toBe(false);
  });
  it('preserves other existing params (e.g. q)', () => {
    const existing = new URLSearchParams('q=my+search');
    const params = serializeFiltersToSearchParams(
      allSchemas,
      { ejendomstype: ['parcelhus'] },
      existing
    );
    expect(params.get('q')).toBe('my search');
    expect(params.get('ejendomstype')).toBe('parcelhus');
  });
  it('round-trip: parse → serialize produces same URL', () => {
    const source = 'ejendomstype=parcelhus,lejlighed&areal=50-150&skjulUdfasede=false';
    const parsed = parseFiltersFromSearchParams(allSchemas, new URLSearchParams(source));
    const serialized = serializeFiltersToSearchParams(allSchemas, parsed);
    // Param order may differ, so compare field-wise
    expect(serialized.get('ejendomstype')).toBe('parcelhus,lejlighed');
    expect(serialized.get('areal')).toBe('50-150');
    expect(serialized.get('skjulUdfasede')).toBe('false');
  });
});

// ─── resetFilters ──────────────────────────────────────────────────────────

describe('resetFilters', () => {
  it('returns toggle defaults + empty for other filters', () => {
    expect(resetFilters(allSchemas)).toEqual({ skjulUdfasede: true });
  });
});

// ─── BIZZ-838: Edge-case tests ──────────────────────────────────────────────

describe('BIZZ-838: comma-escape in multi-select', () => {
  const withComma: MultiSelectFilterSchema = {
    type: 'multi-select',
    key: 'test',
    label: 'Test',
    options: [
      { value: 'a,b', label: 'A,B' },
      { value: 'c', label: 'C' },
    ],
  };

  it('encodes literal commas in values as %2C', () => {
    expect(encodeFilterValue(withComma, ['a,b', 'c'])).toBe('a%2Cb,c');
  });

  it('decodes %2C back to commas in values', () => {
    expect(decodeFilterValue(withComma, 'a%2Cb,c')).toEqual(['a,b', 'c']);
  });

  it('round-trips values with commas', () => {
    const encoded = encodeFilterValue(withComma, ['a,b']);
    expect(decodeFilterValue(withComma, encoded!)).toEqual(['a,b']);
  });
});

describe('BIZZ-838: range regex edge cases', () => {
  it('rejects bare hyphen', () => {
    expect(decodeFilterValue(range, '-')).toBeUndefined();
  });

  it('rejects empty string', () => {
    expect(decodeFilterValue(range, '')).toBeUndefined();
  });

  it('rejects multiple hyphens', () => {
    expect(decodeFilterValue(range, '50-100-200')).toBeUndefined();
  });

  it('rejects non-numeric', () => {
    expect(decodeFilterValue(range, 'abc-def')).toBeUndefined();
  });

  it('accepts valid open-ended ranges', () => {
    expect(decodeFilterValue(range, '50-')).toEqual({ min: 50 });
    expect(decodeFilterValue(range, '-150')).toEqual({ max: 150 });
  });
});
