/**
 * Unit tests for app/lib/forsikring/parseTimestamp — BIZZ-2156.
 *
 * Sikrer at parse-tidsstemplet formateres som relativt label (<24t) eller
 * absolut dato (ældre) med præcist tooltip, på både dansk og engelsk.
 */

import { describe, it, expect } from 'vitest';
import { formatParseTimestamp } from '@/app/lib/forsikring/parseTimestamp';

const NOW = new Date('2026-06-16T15:32:00Z');

describe('formatParseTimestamp', () => {
  it('returnerer null for tom/ugyldig input', () => {
    expect(formatParseTimestamp(null, true, NOW)).toBeNull();
    expect(formatParseTimestamp('', true, NOW)).toBeNull();
    expect(formatParseTimestamp('ikke-en-dato', true, NOW)).toBeNull();
  });

  it('viser "lige nu" når under 1 minut siden', () => {
    const r = formatParseTimestamp('2026-06-16T15:31:30Z', true, NOW);
    expect(r?.label).toBe('Parset lige nu');
  });

  it('viser minutter når under en time siden (da)', () => {
    const r = formatParseTimestamp('2026-06-16T15:17:00Z', true, NOW);
    expect(r?.label).toBe('Parset 15m siden');
  });

  it('viser timer når under et døgn siden (da)', () => {
    const r = formatParseTimestamp('2026-06-16T12:32:00Z', true, NOW);
    expect(r?.label).toBe('Parset 3t siden');
  });

  it('viser timer på engelsk', () => {
    const r = formatParseTimestamp('2026-06-16T12:32:00Z', false, NOW);
    expect(r?.label).toBe('Parsed 3h ago');
  });

  it('viser dato uden år for ældre i samme år (da)', () => {
    const r = formatParseTimestamp('2026-06-14T10:00:00Z', true, NOW);
    expect(r?.label).toBe('Parset 14. jun');
  });

  it('viser dato med år når andet år (da)', () => {
    const r = formatParseTimestamp('2026-03-03T08:00:00Z', true, new Date('2027-01-10T10:00:00Z'));
    expect(r?.label).toBe('Parset 3. mar 2026');
  });

  it('tooltip har præcist klokkeslæt (da)', () => {
    const r = formatParseTimestamp('2026-06-14T15:32:00Z', true, NOW);
    // Lokal tid afhænger af TZ; verificér struktur + dato/måned
    expect(r?.tooltip).toMatch(/^14\. juni 2026 kl\. \d{2}:\d{2}$/);
  });

  it('behandler fremtidigt tidsstempel som "lige nu"', () => {
    const r = formatParseTimestamp('2026-06-16T16:00:00Z', true, NOW);
    expect(r?.label).toBe('Parset lige nu');
  });
});
