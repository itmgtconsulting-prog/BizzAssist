/**
 * BIZZ-707: detectPlaceholders unit tests.
 *
 * Covers the four syntax variants + ordering + counts + false-positive guards.
 */
import { describe, it, expect } from 'vitest';
import { detectPlaceholders, MAX_PLACEHOLDERS } from '@/app/lib/domainPlaceholderDetect';

describe('detectPlaceholders — BIZZ-707', () => {
  it('finds mustache-style placeholders', () => {
    const r = detectPlaceholders('Hello {{navn}}, dato {{dato}}.');
    expect(r.map((p) => p.name)).toEqual(['navn', 'dato']);
    expect(r.every((p) => p.syntax === 'mustache')).toBe(true);
  });

  it('finds bracket-style (uppercase) placeholders', () => {
    const r = detectPlaceholders('Køber [KOEBER] bor på [ADRESSE]');
    expect(r.map((p) => p.name)).toEqual(['KOEBER', 'ADRESSE']);
    expect(r.every((p) => p.syntax === 'bracket')).toBe(true);
  });

  it('finds double-bracket placeholders', () => {
    const r = detectPlaceholders('Felt [[foo]] og [[BAR]]');
    expect(r.map((p) => p.name).sort()).toEqual(['BAR', 'foo']);
  });

  it('finds single-brace placeholders but not JSON', () => {
    const r = detectPlaceholders('Navn: {navn} — data {"key":"val"}');
    const names = r.map((p) => p.name);
    expect(names).toContain('navn');
    expect(names).not.toContain('"key"');
  });

  it('deduplicates and counts occurrences', () => {
    const r = detectPlaceholders('{{navn}} er {{navn}} og {{navn}}');
    expect(r).toHaveLength(1);
    expect(r[0].count).toBe(3);
  });

  it('returns placeholders in document-flow order', () => {
    const r = detectPlaceholders('First {{b}}, then {{a}}, then {{c}}');
    expect(r.map((p) => p.name)).toEqual(['b', 'a', 'c']);
  });

  it('captures context window around each hit', () => {
    const r = detectPlaceholders('Some long text before {{navn}} and some text after');
    expect(r[0].context).toMatch(/before \{\{navn\}\} and some text after/);
  });

  it('supports Danish characters (æøå) in placeholder names', () => {
    const r = detectPlaceholders('Tekst {{sælger_navn}} og [{KØBER}]');
    expect(r.some((p) => p.name === 'sælger_navn')).toBe(true);
  });

  it('returns empty for text with no placeholders', () => {
    expect(detectPlaceholders('Just plain prose with no markers.')).toEqual([]);
  });

  it('caps output at MAX_PLACEHOLDERS', () => {
    const tokens = Array.from({ length: MAX_PLACEHOLDERS + 50 }, (_, i) => `{{p${i}}}`);
    const r = detectPlaceholders(tokens.join(' '));
    expect(r.length).toBeLessThanOrEqual(MAX_PLACEHOLDERS);
  });

  it('handles mixed syntaxes in the same document', () => {
    // single-brace requires 2+ chars (false-positive guard vs JSON/code),
    // so use {dd} not {d} for the single-brace coverage
    const r = detectPlaceholders('{{a}} [B] [[c]] {dd}');
    const names = r.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['a', 'B', 'c', 'dd']));
  });
});
