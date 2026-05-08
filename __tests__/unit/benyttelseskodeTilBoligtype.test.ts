/**
 * BIZZ-1180: Tests for benyttelseskodeTilBoligtype mapping.
 *
 * Verifies VUR benyttelseskode → Boliga property type conversion.
 */

import { describe, it, expect } from 'vitest';
import { benyttelseskodeTilBoligtype } from '@/app/lib/benyttelseskoder';

describe('benyttelseskodeTilBoligtype', () => {
  it('returnerer null for null/undefined', () => {
    expect(benyttelseskodeTilBoligtype(null)).toBeNull();
    expect(benyttelseskodeTilBoligtype(undefined)).toBeNull();
  });

  it('mapper parcelhus (01) til villa', () => {
    expect(benyttelseskodeTilBoligtype('01')).toBe('villa');
    expect(benyttelseskodeTilBoligtype('1')).toBe('villa');
  });

  it('mapper tofamiliehus (02) til villa', () => {
    expect(benyttelseskodeTilBoligtype('02')).toBe('villa');
  });

  it('mapper rækkehus (03, 16) til raekkehus', () => {
    expect(benyttelseskodeTilBoligtype('03')).toBe('raekkehus');
    expect(benyttelseskodeTilBoligtype('16')).toBe('raekkehus');
  });

  it('mapper etageejendom/ejerlejlighed (04, 11) til ejerlejlighed', () => {
    expect(benyttelseskodeTilBoligtype('04')).toBe('ejerlejlighed');
    expect(benyttelseskodeTilBoligtype('11')).toBe('ejerlejlighed');
  });

  it('mapper sommerhus/fritid (21-24) til fritidshus', () => {
    expect(benyttelseskodeTilBoligtype('21')).toBe('fritidshus');
    expect(benyttelseskodeTilBoligtype('22')).toBe('fritidshus');
    expect(benyttelseskodeTilBoligtype('23')).toBe('fritidshus');
    expect(benyttelseskodeTilBoligtype('24')).toBe('fritidshus');
  });

  it('returnerer null for erhverv (30-45)', () => {
    expect(benyttelseskodeTilBoligtype('30')).toBeNull();
    expect(benyttelseskodeTilBoligtype('36')).toBeNull();
  });

  it('returnerer null for ukendt kode', () => {
    expect(benyttelseskodeTilBoligtype('99')).toBeNull();
    expect(benyttelseskodeTilBoligtype('00')).toBeNull();
  });

  it('håndterer kode med whitespace', () => {
    expect(benyttelseskodeTilBoligtype(' 01 ')).toBe('villa');
  });
});
