/**
 * Unit tests for BIZZ-623 Trigger 2 — infra_down detection logic.
 *
 * Pure detection logic: given N recent probe rows for a service, decide if
 * the service should trigger an infra_down scan. The rule is "2 consecutive
 * down states" — matching the acceptance criterion "Ingen falske positive
 * ved single-probe-glitch".
 */

import { describe, it, expect } from 'vitest';

interface ProbeRow {
  service_id: string;
  is_down: boolean;
  detail: string | null;
  probed_at: string;
}

/**
 * Extracted from probeInfraAndDetectDowns() in service-scan route. Takes the
 * 2 most recent probes for a single service (newest first) and returns true
 * iff both indicate a downed state.
 */
function isConsecutivelyDown(recent: ProbeRow[]): boolean {
  return recent.length >= 2 && recent[0].is_down && recent[1].is_down;
}

const NOW = Date.now();
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const row = (service: string, isDown: boolean, minsAgoValue: number): ProbeRow => ({
  service_id: service,
  is_down: isDown,
  detail: isDown ? 'probe HTTP 503' : null,
  probed_at: minsAgo(minsAgoValue),
});

describe('isConsecutivelyDown — BIZZ-623 Trigger 2', () => {
  it('returns false for empty history', () => {
    expect(isConsecutivelyDown([])).toBe(false);
  });

  it('returns false for single row (need 2)', () => {
    expect(isConsecutivelyDown([row('datafordeler', true, 1)])).toBe(false);
  });

  it('returns true when both most recent are down', () => {
    const recent = [row('datafordeler', true, 1), row('datafordeler', true, 61)];
    expect(isConsecutivelyDown(recent)).toBe(true);
  });

  it('returns false when only latest is down (single-glitch)', () => {
    const recent = [row('upstash', true, 1), row('upstash', false, 61)];
    expect(isConsecutivelyDown(recent)).toBe(false);
  });

  it('returns false when only prior was down (recovered)', () => {
    const recent = [row('upstash', false, 1), row('upstash', true, 61)];
    expect(isConsecutivelyDown(recent)).toBe(false);
  });

  it('returns false when both are up', () => {
    const recent = [row('twilio', false, 1), row('twilio', false, 61)];
    expect(isConsecutivelyDown(recent)).toBe(false);
  });

  it('does not look past the second row (even if older rows are down)', () => {
    // Latest OK, previous OK, but 3 older rows were down — should still be false
    const recent = [row('cvr', false, 1), row('cvr', false, 61)];
    expect(isConsecutivelyDown(recent)).toBe(false);
  });
});
