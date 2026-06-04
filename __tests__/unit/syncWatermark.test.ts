/**
 * Unit-tests for BIZZ-1976 persistent watermark-helpers (lib/syncWatermark).
 *
 * Dækker computeSyncFrom (watermark vs bootstrap-fallback + overlap), maxIso
 * (akkumulering på tværs af sider) og shouldAdvanceWatermark (kun-fremad-garanti).
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OVERLAP_MINUTES,
  computeSyncFrom,
  maxIso,
  shouldAdvanceWatermark,
} from '@/app/lib/syncWatermark';

describe('computeSyncFrom — from-grænse for næste kørsel', () => {
  const now = new Date('2026-06-02T12:00:00Z');

  it('genoptager fra (watermark − overlap) når watermark findes', () => {
    const from = computeSyncFrom('2026-05-30T00:00:00Z', 5, 60, now);
    // 60 min før watermark
    expect(from).toBe('2026-05-29T23:00:00.000Z');
  });

  it('selv-helende: watermark fra uger siden bruges uændret (ikke now-baseret)', () => {
    // Cron-nedetid: watermark er 20 dage gammelt, men vi genoptager DERFRA,
    // ikke fra now − windowDays. Dette er hele pointen i BIZZ-1976.
    const from = computeSyncFrom('2026-05-13T00:00:00Z', 5, 60, now);
    expect(from).toBe('2026-05-12T23:00:00.000Z');
  });

  it('falder tilbage til (now − windowDays) når watermark mangler (bootstrap)', () => {
    expect(computeSyncFrom(null, 5, 60, now)).toBe('2026-05-28T12:00:00.000Z');
    expect(computeSyncFrom(undefined, 5, 60, now)).toBe('2026-05-28T12:00:00.000Z');
  });

  it('falder tilbage til bootstrap-vindue ved ugyldigt watermark', () => {
    expect(computeSyncFrom('ikke-en-dato', 5, 60, now)).toBe('2026-05-28T12:00:00.000Z');
  });

  it('respekterer custom overlap-minutter', () => {
    const from = computeSyncFrom('2026-05-30T12:00:00Z', 5, 120, now);
    expect(from).toBe('2026-05-30T10:00:00.000Z');
  });

  it('default overlap er 60 minutter', () => {
    expect(DEFAULT_OVERLAP_MINUTES).toBe(60);
  });
});

describe('maxIso — akkumulering af seneste tidsstempel', () => {
  it('returnerer den seneste af to gyldige ISO-værdier', () => {
    expect(maxIso('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z')).toBe('2026-05-02T00:00:00Z');
    expect(maxIso('2026-05-03T00:00:00Z', '2026-05-02T00:00:00Z')).toBe('2026-05-03T00:00:00Z');
  });

  it('ignorerer null/undefined og returnerer den gyldige', () => {
    expect(maxIso(null, '2026-05-02T00:00:00Z')).toBe('2026-05-02T00:00:00Z');
    expect(maxIso('2026-05-02T00:00:00Z', undefined)).toBe('2026-05-02T00:00:00Z');
  });

  it('returnerer null når begge er ugyldige', () => {
    expect(maxIso(null, null)).toBeNull();
    expect(maxIso('xxx', undefined)).toBeNull();
  });

  it('et enkelt manglende felt nulstiller ikke maxet', () => {
    let acc: string | null = null;
    acc = maxIso(acc, '2026-05-01T00:00:00Z');
    acc = maxIso(acc, null); // manglende sidstIndlaest på ét hit
    acc = maxIso(acc, '2026-05-03T00:00:00Z');
    expect(acc).toBe('2026-05-03T00:00:00Z');
  });
});

describe('shouldAdvanceWatermark — kun-fremad-garanti', () => {
  it('tillader fremskrivning når candidate er strengt nyere', () => {
    expect(shouldAdvanceWatermark('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z')).toBe(true);
  });

  it('blokerer regression (candidate ældre end current)', () => {
    expect(shouldAdvanceWatermark('2026-05-02T00:00:00Z', '2026-05-01T00:00:00Z')).toBe(false);
  });

  it('blokerer uændret (candidate == current)', () => {
    expect(shouldAdvanceWatermark('2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z')).toBe(false);
  });

  it('tillader første watermark når current mangler', () => {
    expect(shouldAdvanceWatermark(null, '2026-05-02T00:00:00Z')).toBe(true);
    expect(shouldAdvanceWatermark(undefined, '2026-05-02T00:00:00Z')).toBe(true);
  });

  it('blokerer når candidate mangler (tomt resultat må ikke nulstille)', () => {
    expect(shouldAdvanceWatermark('2026-05-02T00:00:00Z', null)).toBe(false);
    expect(shouldAdvanceWatermark('2026-05-02T00:00:00Z', undefined)).toBe(false);
    expect(shouldAdvanceWatermark(null, null)).toBe(false);
  });

  it('blokerer ugyldigt candidate', () => {
    expect(shouldAdvanceWatermark('2026-05-02T00:00:00Z', 'ikke-en-dato')).toBe(false);
  });

  it('tillader fremskrivning når current er ugyldigt men candidate er gyldigt', () => {
    expect(shouldAdvanceWatermark('korrupt', '2026-05-02T00:00:00Z')).toBe(true);
  });
});
