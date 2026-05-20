/**
 * Tests for app/lib/piiRedact.ts — BIZZ-1706
 */

import { describe, it, expect } from 'vitest';
import {
  redactCpr,
  respectAddressProtection,
  truncateHistory,
  redactPiiFromSentryEvent,
} from '@/app/lib/piiRedact';

describe('redactCpr', () => {
  it('redacts CPR with dash', () => {
    expect(redactCpr('Person 150685-1234')).toBe('Person [CPR REDACTED]');
  });

  it('redacts CPR without dash', () => {
    expect(redactCpr('CPR: 1506851234')).toBe('CPR: [CPR REDACTED]');
  });

  it('does not redact invalid dates', () => {
    expect(redactCpr('Number: 991385-1234')).toBe('Number: 991385-1234'); // month 13
  });

  it('redacts multiple CPRs', () => {
    expect(redactCpr('A: 010190-1234 B: 150685-5678')).toBe('A: [CPR REDACTED] B: [CPR REDACTED]');
  });

  it('preserves BFE numbers', () => {
    expect(redactCpr('BFE 100165718')).toBe('BFE 100165718');
  });

  it('preserves phone numbers', () => {
    expect(redactCpr('Tlf: 70 80 90 39')).toBe('Tlf: 70 80 90 39');
  });

  it('handles empty string', () => {
    expect(redactCpr('')).toBe('');
  });
});

describe('respectAddressProtection', () => {
  it('returns Privat ejer when protected', () => {
    const result = respectAddressProtection({
      navn: 'Jakob Rasmussen',
      adresse: 'Hemmeligt 1',
      adresseBeskyttelse: true,
    });
    expect(result.displayName).toBe('Privat ejer');
    expect(result.displayAddress).toBeNull();
  });

  it('returns real name when not protected', () => {
    const result = respectAddressProtection({
      navn: 'Jakob Rasmussen',
      adresse: 'Søbyvej 11',
      adresseBeskyttelse: false,
    });
    expect(result.displayName).toBe('Jakob Rasmussen');
    expect(result.displayAddress).toBe('Søbyvej 11');
  });

  it('returns Ukendt when no name', () => {
    const result = respectAddressProtection({});
    expect(result.displayName).toBe('Ukendt');
  });
});

describe('truncateHistory', () => {
  it('filters old events', () => {
    const events = [
      { dato: '2026-01-01', label: 'recent' },
      { dato: '2010-01-01', label: 'old' },
    ];
    const filtered = truncateHistory(events, 10);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].label).toBe('recent');
  });

  it('keeps events without date', () => {
    const events = [{ label: 'no date' }];
    const filtered = truncateHistory(events, 10);
    expect(filtered).toHaveLength(1);
  });
});

describe('redactPiiFromSentryEvent', () => {
  it('redacts CPR in nested event', () => {
    const event = { message: 'Ejer 150685-1234 fandt', tags: { user: 'test' } };
    const result = redactPiiFromSentryEvent(event);
    expect(JSON.stringify(result)).toContain('[CPR REDACTED]');
    expect(JSON.stringify(result)).not.toContain('150685-1234');
  });

  it('preserves event without CPR', () => {
    const event = { message: 'Normal event', level: 'info' };
    const result = redactPiiFromSentryEvent(event);
    expect(result).toBe(event); // Same reference — not modified
  });
});
