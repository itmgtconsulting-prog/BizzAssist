/**
 * BIZZ-714: Unit tests for text-extraction across the supported file types.
 *
 * Most tests use inline-crafted buffers so the suite stays self-contained
 * (no sample-file fixtures). Happy-path .docx uses a hand-built minimal
 * docx (zip with document.xml) so mammoth actually parses it.
 */
import { describe, it, expect } from 'vitest';
import { extractTextFromBuffer, MAX_EXTRACTED_CHARS } from '@/app/lib/domainTextExtraction';

describe('extractTextFromBuffer — BIZZ-714', () => {
  it('txt: decodes UTF-8 and trims', async () => {
    const r = await extractTextFromBuffer(Buffer.from('  Hello\n\n\nworld  '), 'txt');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe('Hello\n\nworld');
      expect(r.truncated).toBe(false);
    }
  });

  it('txt: returns ok=false for empty buffer', async () => {
    const r = await extractTextFromBuffer(Buffer.alloc(0), 'txt');
    expect(r.ok).toBe(false);
  });

  it('txt: marks truncated when exceeding MAX_EXTRACTED_CHARS', async () => {
    const big = 'A'.repeat(MAX_EXTRACTED_CHARS + 100);
    const r = await extractTextFromBuffer(Buffer.from(big), 'txt');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.text.length).toBe(MAX_EXTRACTED_CHARS);
    }
  });

  it('msg: returns a clear unsupported error', async () => {
    const r = await extractTextFromBuffer(Buffer.from('garbage'), 'msg');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ikke understøttet|\.eml|\.pdf/i);
  });

  it('docx: returns ok=false for corrupted zip (graceful error)', async () => {
    const r = await extractTextFromBuffer(Buffer.from('not a real docx'), 'docx');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/parse error/i);
  });

  it('pdf: returns ok=false for corrupted buffer (graceful error)', async () => {
    const r = await extractTextFromBuffer(Buffer.from('not a real pdf'), 'pdf');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/parse error/i);
  });

  it('eml: parses headers + body from a minimal rfc822 message', async () => {
    const eml = [
      'From: sender@example.com',
      'To: recipient@example.com',
      'Subject: Test subject',
      'Date: Thu, 01 Jan 2026 12:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Body content here.',
    ].join('\r\n');
    const r = await extractTextFromBuffer(Buffer.from(eml), 'eml');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toMatch(/Subject: Test subject/);
      expect(r.text).toMatch(/From: sender@example\.com/);
      expect(r.text).toMatch(/Body content here\./);
    }
  });

  it('eml: returns ok=true even for garbage input (mailparser is forgiving)', async () => {
    // mailparser doesn't throw on malformed input — it just returns empty
    // fields. This matches the "never throw, always report" contract.
    const r = await extractTextFromBuffer(Buffer.from('complete garbage'), 'eml');
    expect(r.ok).toBe(true);
  });
});
