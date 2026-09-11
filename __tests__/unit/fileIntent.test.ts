/**
 * Unit tests for app/lib/fileIntent — BIZZ-2290.
 *
 * detectFileIntent gates the AI chat's honest file-fallback, so it must catch
 * explicit export requests (incl. the exact phrasings from the bug report) and
 * not fire on unrelated words like "profil"/"filtrering".
 */
import { describe, it, expect } from 'vitest';
import { detectFileIntent } from '@/app/lib/fileIntent';

describe('detectFileIntent', () => {
  it('detects the phrasings from the bug report (BIZZ-2290)', () => {
    expect(detectFileIntent('gerne i excel')).toBe(true);
    expect(detectFileIntent('jeg vil gerne have excel fil?')).toBe(true);
  });

  it.each([
    'Lav en Excel med de 5 ejendomme',
    'Eksportér listen til csv',
    'Generer et Word-dokument med resuméet',
    'Downloade som xlsx',
    'giv mig en pptx',
    'lav et regneark',
    'kan jeg få det som powerpoint',
    'eksporter til docx',
  ])('returns true for explicit file request: %s', (text) => {
    expect(detectFileIntent(text)).toBe(true);
  });

  it.each([
    'vis mig en liste over ejendommene',
    'hvad er profilen for virksomheden',
    'lav en filtrering på kommune',
    'fortæl mig om ejeren',
    '',
  ])('returns false for non-file requests: %s', (text) => {
    expect(detectFileIntent(text)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(detectFileIntent('LAV EN EXCEL')).toBe(true);
    expect(detectFileIntent('CSV')).toBe(true);
  });
});
