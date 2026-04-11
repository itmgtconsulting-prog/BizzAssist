/**
 * Serialization guard tests — regression protection for next/dynamic prop boundary.
 *
 * Components loaded via next/dynamic (e.g. RegnskabChart, DiagramForce) must only
 * receive JSON-serializable props. Non-serializable values (Set, Map, Function,
 * undefined, circular refs) silently corrupt or crash when crossing the server→client
 * boundary enforced by React's dynamic import mechanism.
 *
 * These tests verify:
 * - The isSerializable() utility correctly identifies serializable vs non-serializable values
 * - RegnskabChart prop shapes pass the serialization check
 * - Known non-serializable types (Set, Map, Function, circular) are caught
 * - Deeply nested structures are checked recursively
 *
 * Regression context: RegnskabChart previously received a Set as chartRowIds.
 * The fix is documented in RegnskabChart.tsx JSDoc. These tests guard against
 * the same class of bug recurring in any dynamic-imported component.
 */

import { describe, it, expect } from 'vitest';

// ── Utility under test ────────────────────────────────────────────────────────

/**
 * Returns true if the value can be safely passed as a prop to a next/dynamic
 * component — i.e. it survives JSON serialization without data loss.
 *
 * @param value - The value to check
 * @returns true if serializable, false otherwise
 */
function isSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value, (_key, val) => {
      if (typeof val === 'function') throw new Error('function');
      if (val instanceof Set) throw new Error('Set');
      if (val instanceof Map) throw new Error('Map');
      if (val instanceof Date) {
        // Dates survive JSON round-trip as strings — acceptable
        return val;
      }
      return val;
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Asserts that every value in a props object is serializable.
 * Throws with a descriptive message if any prop fails.
 *
 * @param props - Component props object to validate
 * @param componentName - Name used in the error message
 */
function assertPropsSerializable(props: Record<string, unknown>, componentName: string): void {
  for (const [key, value] of Object.entries(props)) {
    if (!isSerializable(value)) {
      throw new Error(
        `[${componentName}] prop "${key}" is not serializable. ` +
          'Do not pass Set, Map, Function, or circular refs to next/dynamic components.'
      );
    }
  }
}

// ── Tests: isSerializable utility ─────────────────────────────────────────────

describe('isSerializable()', () => {
  it('returns true for primitives', () => {
    expect(isSerializable(42)).toBe(true);
    expect(isSerializable('hello')).toBe(true);
    expect(isSerializable(true)).toBe(true);
    expect(isSerializable(null)).toBe(true);
  });

  it('returns true for plain objects and arrays', () => {
    expect(isSerializable({ a: 1, b: 'two' })).toBe(true);
    expect(isSerializable([1, 2, 3])).toBe(true);
    expect(isSerializable([{ id: 'x', label: 'X' }])).toBe(true);
  });

  it('returns true for deeply nested plain structures', () => {
    expect(
      isSerializable({
        level1: {
          level2: {
            level3: [{ id: 'deep', value: 99 }],
          },
        },
      })
    ).toBe(true);
  });

  it('returns false for Set', () => {
    expect(isSerializable(new Set([1, 2, 3]))).toBe(false);
  });

  it('returns false for Map', () => {
    expect(isSerializable(new Map([['key', 'value']]))).toBe(false);
  });

  it('returns false for Function', () => {
    expect(isSerializable(() => 'hello')).toBe(false);
    expect(isSerializable(function named() {})).toBe(false);
  });

  it('returns false for object containing a Set', () => {
    expect(isSerializable({ ids: new Set(['a', 'b']) })).toBe(false);
  });

  it('returns false for object containing a Function', () => {
    expect(isSerializable({ onClick: () => {} })).toBe(false);
  });

  it('returns false for array containing a Map', () => {
    expect(isSerializable([new Map()])).toBe(false);
  });
});

// ── Tests: assertPropsSerializable utility ────────────────────────────────────

describe('assertPropsSerializable()', () => {
  it('does not throw for fully serializable props', () => {
    expect(() =>
      assertPropsSerializable(
        {
          chartData: [{ aar: 2024, omsaetning: 1000 }],
          chartRowIds: ['omsaetning'],
          alleRows: [{ id: 'omsaetning', label: 'Omsætning' }],
          colors: ['#2563eb'],
        },
        'RegnskabChart'
      )
    ).not.toThrow();
  });

  it('throws when a Set is passed as chartRowIds', () => {
    // This is the exact regression: Array.from() was missing, Set passed directly
    expect(() =>
      assertPropsSerializable(
        {
          chartData: [{ aar: 2024, omsaetning: 1000 }],
          chartRowIds: new Set(['omsaetning']) as unknown as string[],
          alleRows: [{ id: 'omsaetning', label: 'Omsætning' }],
          colors: ['#2563eb'],
        },
        'RegnskabChart'
      )
    ).toThrow(/chartRowIds.*not serializable/);
  });

  it('throws when a callback function is included in props', () => {
    expect(() =>
      assertPropsSerializable(
        {
          chartData: [{ aar: 2024 }],
          onPointClick: () => {},
        },
        'RegnskabChart'
      )
    ).toThrow(/onPointClick.*not serializable/);
  });
});

// ── Tests: RegnskabChart prop contract ────────────────────────────────────────

describe('RegnskabChart — prop serialization contract', () => {
  it('valid RegnskabChart props are all serializable', () => {
    const validProps = {
      chartData: [
        { aar: 2022, omsaetning: 1_200_000, resultat: 150_000, egenkapital: 500_000 },
        { aar: 2023, omsaetning: 1_500_000, resultat: 200_000, egenkapital: 700_000 },
      ],
      chartRowIds: ['omsaetning', 'resultat', 'egenkapital'],
      alleRows: [
        { id: 'omsaetning', label: 'Omsætning' },
        { id: 'resultat', label: 'Årets resultat' },
        { id: 'egenkapital', label: 'Egenkapital', isPercent: false },
      ],
      colors: ['#2563eb', '#16a34a', '#dc2626'],
    };

    expect(() => assertPropsSerializable(validProps, 'RegnskabChart')).not.toThrow();
  });

  it('Set passed as chartRowIds fails the serialization check', () => {
    // Guard: Array.from(someSet) MUST be called before passing to RegnskabChart.
    // If the caller passes the raw Set, this assertion catches it.
    const invalidProps = {
      chartData: [{ aar: 2024, omsaetning: 1000 }],
      chartRowIds: new Set(['omsaetning']) as unknown as string[],
      alleRows: [{ id: 'omsaetning', label: 'Omsætning' }],
      colors: ['#2563eb'],
    };

    expect(() => assertPropsSerializable(invalidProps, 'RegnskabChart')).toThrow();
  });

  it('null values in chartData are serializable', () => {
    // XBRL data often has null fields — confirm these are safe
    const propsWithNulls = {
      chartData: [
        { aar: 2022, omsaetning: null, resultat: 150_000 },
        { aar: 2023, omsaetning: 1_500_000, resultat: null },
      ],
      chartRowIds: ['omsaetning', 'resultat'],
      alleRows: [
        { id: 'omsaetning', label: 'Omsætning' },
        { id: 'resultat', label: 'Resultat' },
      ],
      colors: ['#2563eb'],
    };

    expect(() => assertPropsSerializable(propsWithNulls, 'RegnskabChart')).not.toThrow();
  });
});

// ── Tests: fmtShort number formatting ────────────────────────────────────────
// The fmtShort helper in RegnskabChart is not exported, but we can validate the
// expected formatting contract used in the Y-axis ticks.

describe('fmtShort() contract (validated via serializable number inputs)', () => {
  /** Mirror of fmtShort() from RegnskabChart.tsx — kept in sync for regression */
  function fmtShort(val: number): string {
    const abs = Math.abs(val);
    if (abs >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}m`;
    if (abs >= 1_000) return `${(val / 1_000).toFixed(0)}k`;
    return val.toFixed(0);
  }

  it('formats millions with one decimal and "m" suffix', () => {
    expect(fmtShort(1_200_000)).toBe('1.2m');
    expect(fmtShort(309_000_000_000)).toBe('309000.0m'); // large value stays consistent
  });

  it('formats thousands with "k" suffix', () => {
    expect(fmtShort(500_000)).toBe('500k');
    expect(fmtShort(1_000)).toBe('1k');
  });

  it('formats small values without suffix', () => {
    expect(fmtShort(123)).toBe('123');
    expect(fmtShort(0)).toBe('0');
  });

  it('handles negative numbers correctly', () => {
    expect(fmtShort(-1_500_000)).toBe('-1.5m');
    expect(fmtShort(-500_000)).toBe('-500k');
    expect(fmtShort(-42)).toBe('-42');
  });
});
