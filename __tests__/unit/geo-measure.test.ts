/**
 * Unit tests for app/lib/geo/measure — BIZZ-2284.
 *
 * References are independent, known geodesic (spherical) values — not turf's own
 * output — so the test genuinely validates the math:
 *  - 1° of latitude along a meridian ≈ 111 195 m (π/180 × mean Earth radius).
 *  - 1° of longitude at 60°N ≈ cos(60°) × 111 195 ≈ 55 597 m.
 *  - Copenhagen ↔ Aarhus great-circle ≈ 157 km.
 *
 * (Placed in __tests__/unit per vitest.config include; the source lives at
 * app/lib/geo/measure.ts.)
 */
import { describe, it, expect } from 'vitest';
import {
  lineDistanceMeters,
  polygonAreaM2,
  formatDistance,
  formatArea,
  type LngLat,
} from '@/app/lib/geo/measure';

/** Asserts `actual` is within `pct` percent of `expected`. */
function expectWithin(actual: number, expected: number, pct: number): void {
  const tolerance = Math.abs(expected) * (pct / 100);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe('lineDistanceMeters', () => {
  it('measures 1° of latitude as ≈111 195 m (±0.5%)', () => {
    expectWithin(
      lineDistanceMeters([
        [0, 55],
        [0, 56],
      ]),
      111_195,
      0.5
    );
  });

  it('measures 1° of longitude at 60°N as ≈55 597 m (±0.5%)', () => {
    expectWithin(
      lineDistanceMeters([
        [0, 60],
        [1, 60],
      ]),
      55_597,
      0.5
    );
  });

  it('sums multi-segment polylines (2° latitude ≈222 390 m)', () => {
    expectWithin(
      lineDistanceMeters([
        [0, 0],
        [0, 1],
        [0, 2],
      ]),
      222_390,
      0.5
    );
  });

  it('matches the Copenhagen↔Aarhus great-circle (~157 km, ±1%)', () => {
    const cph: LngLat = [12.5683, 55.6761];
    const aarhus: LngLat = [10.2039, 56.1572];
    expectWithin(lineDistanceMeters([cph, aarhus]), 157_000, 1);
  });

  it('returns 0 for fewer than two points', () => {
    expect(lineDistanceMeters([])).toBe(0);
    expect(lineDistanceMeters([[12, 55]])).toBe(0);
  });
});

describe('polygonAreaM2', () => {
  it('measures a ~0.01°×0.01° square near the equator (~1.24e6 m², ±1%)', () => {
    const ring: LngLat[] = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0.01],
    ];
    expectWithin(polygonAreaM2(ring), 1_236_000, 1);
  });

  it('auto-closes an open ring (same area as the closed ring)', () => {
    const open: LngLat[] = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0.01],
    ];
    const closed: LngLat[] = [...open, [0, 0]];
    expect(polygonAreaM2(open)).toBeCloseTo(polygonAreaM2(closed), 2);
  });

  it('returns 0 for degenerate rings (<3 vertices)', () => {
    expect(polygonAreaM2([])).toBe(0);
    expect(
      polygonAreaM2([
        [0, 0],
        [1, 1],
      ])
    ).toBe(0);
  });
});

describe('formatDistance', () => {
  it.each([
    [742, '742 m'],
    [999, '999 m'],
    [1000, '1,00 km'],
    [1570, '1,57 km'],
    [15_700, '15,70 km'],
  ])('formats %i m as "%s"', (m, expected) => {
    expect(formatDistance(m)).toBe(expected);
  });

  it('guards against invalid input', () => {
    expect(formatDistance(-5)).toBe('0 m');
    expect(formatDistance(NaN)).toBe('0 m');
  });
});

describe('formatArea', () => {
  it.each([
    [8450, '8.450 m²'],
    [9999, '9.999 m²'],
    [10_000, '1,00 ha'],
    [32_100, '3,21 ha'],
  ])('formats %i m² as "%s"', (m2, expected) => {
    expect(formatArea(m2)).toBe(expected);
  });

  it('guards against invalid input', () => {
    expect(formatArea(-1)).toBe('0 m²');
    expect(formatArea(NaN)).toBe('0 m²');
  });
});
