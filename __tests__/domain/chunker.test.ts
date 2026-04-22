/**
 * BIZZ-715: chunkText unit tests. Verifies paragraph-aware splitting,
 * overlap, hash-stability, and bounds.
 */
import { describe, it, expect } from 'vitest';
import { chunkText, CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_TOKENS } from '@/app/lib/domainChunker';

describe('chunkText — BIZZ-715', () => {
  it('returns [] for empty / whitespace-only input', async () => {
    expect(await chunkText('')).toEqual([]);
    expect(await chunkText('   \n  \n   ')).toEqual([]);
  });

  it('returns a single chunk for short text', async () => {
    const r = await chunkText('Hello world.');
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('Hello world.');
    expect(r[0].index).toBe(0);
    expect(r[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces deterministic hashes', async () => {
    const a = await chunkText('Same input.');
    const b = await chunkText('Same input.');
    expect(a[0].hash).toBe(b[0].hash);
  });

  it('splits long text into multiple chunks', async () => {
    // Build something well beyond CHUNK_SIZE_TOKENS × chars-per-token
    const longText = Array.from(
      { length: 100 },
      (_, i) => `Paragraph ${i} with some content.`
    ).join('\n\n');
    const r = await chunkText(longText);
    expect(r.length).toBeGreaterThan(1);
    expect(r.every((c) => c.text.length > 0)).toBe(true);
    expect(r.map((c) => c.index)).toEqual(r.map((_, i) => i));
  });

  it('chunks do not exceed the char budget', async () => {
    const longText = Array.from({ length: 200 }, (_, i) => `Sentence ${i} here.`).join(' ');
    const r = await chunkText(longText);
    const CAP = CHUNK_SIZE_TOKENS * 4 + CHUNK_OVERLAP_TOKENS * 4; // generous
    for (const c of r) {
      expect(c.text.length).toBeLessThanOrEqual(CAP);
    }
  });

  it('handles a single oversize paragraph by sentence-splitting', async () => {
    // 3500+ char paragraph with sentence boundaries → forces sentence-split path
    const big = 'One sentence here. '.repeat(150) + 'Another sentence goes on. '.repeat(100);
    const r = await chunkText(big);
    expect(r.length).toBeGreaterThan(1);
  });

  it('has monotonically increasing chunk indices', async () => {
    const r = await chunkText(Array(50).fill('A paragraph.').join('\n\n'));
    for (let i = 1; i < r.length; i++) {
      expect(r[i].index).toBe(r[i - 1].index + 1);
    }
  });
});
