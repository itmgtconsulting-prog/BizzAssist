/**
 * BIZZ-726: STATUS_TEKST_RE catches all Tinglysning status-text variants so
 * they don't get mis-classified as person owners in the ejerskabs-diagram.
 */
import { describe, it, expect } from 'vitest';
import { STATUS_TEKST_RE } from '@/app/api/ejerskab/chain/route';

describe('STATUS_TEKST_RE — BIZZ-726 status-text detection', () => {
  it('matches "Opdelt i anpart 1-2" (bug report case)', () => {
    expect(STATUS_TEKST_RE.test('Opdelt i anpart 1-2')).toBe(true);
  });

  it('matches singular and plural anpart variants', () => {
    expect(STATUS_TEKST_RE.test('Opdelt i anpart')).toBe(true);
    expect(STATUS_TEKST_RE.test('Opdelt i anparter')).toBe(true);
    expect(STATUS_TEKST_RE.test('opdelt i anparter')).toBe(true);
  });

  it('still matches the original "ideelle anparter" variants (no regression)', () => {
    expect(STATUS_TEKST_RE.test('Opdelt i ideelle anparter')).toBe(true);
    expect(STATUS_TEKST_RE.test('Opdelt i ideel anpart')).toBe(true);
  });

  it('matches ejerlejlighed singular and plural with optional nr-range', () => {
    expect(STATUS_TEKST_RE.test('Opdelt i ejerlejlighed')).toBe(true);
    expect(STATUS_TEKST_RE.test('Opdelt i ejerlejligheder')).toBe(true);
    expect(STATUS_TEKST_RE.test('Opdelt i ejerlejlighed 1-4, 8-56')).toBe(true);
  });

  it('matches "Del af samlet ejendom"', () => {
    expect(STATUS_TEKST_RE.test('Del af samlet ejendom')).toBe(true);
  });

  it('does NOT match real person or company names', () => {
    expect(STATUS_TEKST_RE.test('Jakob Juul Rasmussen')).toBe(false);
    expect(STATUS_TEKST_RE.test('ArnBo 62 ApS')).toBe(false);
    expect(STATUS_TEKST_RE.test('JAJR Holding ApS')).toBe(false);
  });

  it('handles leading whitespace', () => {
    expect(STATUS_TEKST_RE.test('  Opdelt i anpart')).toBe(true);
  });
});
