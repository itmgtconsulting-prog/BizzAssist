/**
 * Unit tests for app/lib/pdfSanitise.ts
 *
 * Covers control-character stripping, replacement-character removal,
 * truncation, fallback behaviour, and the sanitiseLong convenience wrapper.
 */
import { describe, it, expect } from 'vitest';
import { sanitise, sanitiseLong } from '@/app/lib/pdfSanitise';

describe('sanitise', () => {
  it('returns fallback for null', () => {
    expect(sanitise(null)).toBe('–');
  });

  it('returns fallback for undefined', () => {
    expect(sanitise(undefined)).toBe('–');
  });

  it('returns fallback for empty string', () => {
    expect(sanitise('')).toBe('–');
  });

  it('returns fallback for whitespace-only string', () => {
    expect(sanitise('   ')).toBe('–');
  });

  it('passes through clean strings unchanged', () => {
    expect(sanitise('Vestergade 42, København')).toBe('Vestergade 42, København');
  });

  it('strips null bytes (U+0000)', () => {
    expect(sanitise('Hello\u0000World')).toBe('HelloWorld');
  });

  it('strips control characters U+0001–U+0008', () => {
    expect(sanitise('A\u0001B\u0007C\u0008D')).toBe('ABCD');
  });

  it('preserves tab (U+0009)', () => {
    expect(sanitise('A\tB')).toBe('A\tB');
  });

  it('preserves newline (U+000A)', () => {
    expect(sanitise('A\nB')).toBe('A\nB');
  });

  it('strips U+000B–U+001F', () => {
    expect(sanitise('A\u000BC\u001FD')).toBe('ACD');
  });

  it('strips Unicode replacement character U+FFFD', () => {
    expect(sanitise('Hej\uFFFDVerden')).toBe('HejVerden');
  });

  it('truncates to maxLength and appends ellipsis', () => {
    const long = 'A'.repeat(600);
    const result = sanitise(long, 500);
    expect(result.length).toBe(501); // 500 chars + '…'
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not truncate strings at exactly maxLength', () => {
    const exact = 'B'.repeat(500);
    expect(sanitise(exact, 500)).toBe(exact);
  });

  it('uses custom fallback', () => {
    expect(sanitise(null, 500, 'N/A')).toBe('N/A');
  });

  it('returns fallback when only control chars remain after stripping', () => {
    expect(sanitise('\u0000\u0001\u0002')).toBe('–');
  });

  it('handles string with mixed valid and invalid chars', () => {
    expect(sanitise('\u0000Matr.\u0001 12a\uFFFD')).toBe('Matr. 12a');
  });

  it('preserves Danish special characters', () => {
    expect(sanitise('Ærøskøbing Å')).toBe('Ærøskøbing Å');
  });
});

describe('sanitiseLong', () => {
  it('allows up to 2000 characters', () => {
    const long = 'X'.repeat(2000);
    expect(sanitiseLong(long)).toBe(long);
  });

  it('truncates beyond 2000 characters', () => {
    const tooLong = 'Y'.repeat(2500);
    const result = sanitiseLong(tooLong);
    expect(result.length).toBe(2001); // 2000 + '…'
    expect(result.endsWith('…')).toBe(true);
  });

  it('uses default fallback', () => {
    expect(sanitiseLong(null)).toBe('–');
  });

  it('accepts custom fallback', () => {
    expect(sanitiseLong('', 'Ingen data')).toBe('Ingen data');
  });
});
