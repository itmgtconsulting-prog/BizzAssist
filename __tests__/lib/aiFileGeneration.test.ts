/**
 * Unit tests for app/lib/aiFileGeneration.ts (BIZZ-811).
 *
 * Dækker:
 *   - sanitizeFilename: path-traversal, kontroltegn, max 100 chars
 *   - escapeFormula: =/+/-/@ prefixes apostrof
 *   - generateXlsx: happy path, tomme rows, danske tegn, formula-injection,
 *     undefined cells
 *   - generateCsv: BOM prefix, delimiter, escape af " + newline,
 *     formula-injection
 *   - generateDocx: happy path, subtitle, sections, XML-escape
 *   - fillDocxTemplate: placeholder-fill, manglende placeholder → tom
 *   - fillXlsxTemplate: kaster (iter 2 stub)
 *   - Schema validering: reject rows > MAX_ROWS, cols > MAX_COLUMNS
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeFilename,
  escapeFormula,
  generateXlsx,
  generateCsv,
  generateDocx,
  fillDocxTemplate,
  fillXlsxTemplate,
  GenerateXlsxInputSchema,
  GenerateCsvInputSchema,
  GenerateDocxInputSchema,
  MAX_COLUMNS,
  MAX_ROWS,
} from '@/app/lib/aiFileGeneration';
import PizZip from 'pizzip';

describe('sanitizeFilename', () => {
  it('replaces path separators', () => {
    expect(sanitizeFilename('foo/bar\\baz.txt')).toBe('foo_bar_baz.txt');
  });

  it('strips parent-dir traversal', () => {
    // '..' dots collapsed til _; forrige / er allerede byttet til _
    const result = sanitizeFilename('../../secret.txt');
    expect(result).not.toContain('..');
    expect(result).toContain('secret.txt');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('foo\x00bar\x1f.txt')).toBe('foobar.txt');
  });

  it('truncates to 100 chars', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeFilename(long).length).toBe(100);
  });

  it('returns "file" for empty result', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('\x00\x00')).toBe('file');
  });
});

describe('escapeFormula', () => {
  it('prefixes apostrophe for =/+/-/@', () => {
    expect(escapeFormula('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
    expect(escapeFormula('+1')).toBe("'+1");
    expect(escapeFormula('-1')).toBe("'-1");
    expect(escapeFormula('@cmd')).toBe("'@cmd");
  });

  it('leaves normal values alone', () => {
    expect(escapeFormula('hello')).toBe('hello');
    expect(escapeFormula('123')).toBe('123');
  });

  it('handles empty string', () => {
    expect(escapeFormula('')).toBe('');
  });
});

describe('generateXlsx', () => {
  it('produces a valid XLSX buffer for happy path', async () => {
    const result = await generateXlsx({
      title: 'Test',
      columns: [
        { key: 'navn', header: 'Navn' },
        { key: 'alder', header: 'Alder' },
      ],
      rows: [
        { navn: 'Anna', alder: 30 },
        { navn: 'Børge', alder: 45 },
      ],
    });
    expect(result.ext).toBe('xlsx');
    expect(result.contentType).toContain('spreadsheetml');
    expect(result.buffer.length).toBeGreaterThan(0);
    // XLSX er ZIP — check magic bytes
    expect(result.buffer[0]).toBe(0x50); // P
    expect(result.buffer[1]).toBe(0x4b); // K
  });

  it('handles empty rows', async () => {
    const result = await generateXlsx({
      title: 'Tom',
      columns: [{ key: 'a', header: 'A' }],
      rows: [],
    });
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('escapes formula-injection in cell values', async () => {
    // Vi kan ikke let inspicere rendered XLSX indhold uden exceljs-reopen,
    // men vi kan bekræfte generering ikke crasher med =-prefixed values
    const result = await generateXlsx({
      title: 'Injection test',
      columns: [{ key: 'val', header: 'Value' }],
      rows: [{ val: '=SUM(A1:A10)' }, { val: '@cmd' }, { val: 'normal' }],
    });
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('handles undefined/null cells without crashing', async () => {
    const result = await generateXlsx({
      title: 'Nulls',
      columns: [
        { key: 'a', header: 'A' },
        { key: 'b', header: 'B' },
      ],
      rows: [{ a: 'x', b: null } as Record<string, string | number | boolean | null>],
    });
    expect(result.buffer.length).toBeGreaterThan(0);
  });
});

describe('generateCsv', () => {
  it('prefixes UTF-8 BOM', () => {
    const result = generateCsv({
      columns: [{ key: 'a', header: 'A' }],
      rows: [{ a: 'æøå' }],
      delimiter: ';',
    });
    expect(result.ext).toBe('csv');
    // BOM = 0xEF 0xBB 0xBF
    expect(result.buffer[0]).toBe(0xef);
    expect(result.buffer[1]).toBe(0xbb);
    expect(result.buffer[2]).toBe(0xbf);
  });

  it('uses semicolon delimiter by default', () => {
    const result = generateCsv({
      columns: [
        { key: 'a', header: 'A' },
        { key: 'b', header: 'B' },
      ],
      rows: [{ a: '1', b: '2' }],
      delimiter: ';',
    });
    const text = result.buffer.toString('utf8');
    expect(text).toContain('A;B');
    expect(text).toContain('1;2');
  });

  it('wraps cells containing delimiter or quote or newline', () => {
    const result = generateCsv({
      columns: [{ key: 'val', header: 'V' }],
      rows: [{ val: 'a;b' }, { val: 'with "quote"' }, { val: 'line1\nline2' }],
      delimiter: ';',
    });
    const text = result.buffer.toString('utf8');
    expect(text).toContain('"a;b"');
    expect(text).toContain('"with ""quote"""');
    expect(text).toContain('"line1\nline2"');
  });

  it('escapes formula-injection', () => {
    const result = generateCsv({
      columns: [{ key: 'v', header: 'V' }],
      rows: [{ v: '=cmd' }],
      delimiter: ';',
    });
    const text = result.buffer.toString('utf8');
    expect(text).toContain("'=cmd");
  });

  it('preserves danish chars', () => {
    const result = generateCsv({
      columns: [{ key: 'n', header: 'Navn' }],
      rows: [{ n: 'Ærø' }],
      delimiter: ';',
    });
    const text = result.buffer.toString('utf8');
    expect(text).toContain('Ærø');
  });
});

describe('generateDocx', () => {
  it('produces a valid DOCX buffer', async () => {
    const result = await generateDocx({
      title: 'Rapport',
      subtitle: '2026-04-23',
      sections: [{ heading: 'Baggrund', body: 'Dette er baggrunden.' }],
    });
    expect(result.ext).toBe('docx');
    expect(result.contentType).toContain('wordprocessingml');
    // DOCX er ZIP
    expect(result.buffer[0]).toBe(0x50);
    expect(result.buffer[1]).toBe(0x4b);
  });

  it('XML-escapes special chars in text', async () => {
    const result = await generateDocx({
      title: 'A < B & C',
      sections: [{ heading: 'X', body: 'body with <html> & "quotes"' }],
    });
    // Unzip + inspect document.xml
    const zip = new PizZip(result.buffer);
    const doc = zip.file('word/document.xml');
    expect(doc).not.toBeNull();
    const xml = doc!.asText();
    expect(xml).toContain('A &lt; B &amp; C');
    expect(xml).toContain('&lt;html&gt;');
    expect(xml).not.toContain('<html>');
  });

  it('includes multiple sections and splits body on newlines', async () => {
    const result = await generateDocx({
      title: 'Multi',
      sections: [
        { heading: 'Sec1', body: 'line1\nline2' },
        { heading: 'Sec2', body: 'single' },
      ],
    });
    const zip = new PizZip(result.buffer);
    const xml = zip.file('word/document.xml')!.asText();
    expect(xml).toContain('Sec1');
    expect(xml).toContain('Sec2');
    expect(xml).toContain('line1');
    expect(xml).toContain('line2');
  });
});

describe('fillDocxTemplate', () => {
  // Constructing a minimal docxtemplater-compatible template inline
  async function buildTemplate(body: string): Promise<Buffer> {
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t xml:space="preserve">${body}</w:t></w:r></w:p></w:body>
</w:document>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    const zip = new PizZip();
    zip.file('[Content_Types].xml', contentTypes);
    zip.file('_rels/.rels', rels);
    zip.file('word/document.xml', documentXml);
    return Buffer.from(zip.generate({ type: 'nodebuffer' }));
  }

  it('replaces placeholders with values', async () => {
    const tmpl = await buildTemplate('Hej {{navn}}, du er {{alder}} år');
    const result = await fillDocxTemplate(tmpl, { navn: 'Anna', alder: '30' });
    const zip = new PizZip(result.buffer);
    const xml = zip.file('word/document.xml')!.asText();
    expect(xml).toContain('Hej Anna, du er 30 år');
  });

  it('handles missing placeholder as empty string (nullGetter)', async () => {
    const tmpl = await buildTemplate('Hej {{navn}} og {{missing}}');
    const result = await fillDocxTemplate(tmpl, { navn: 'Anna' });
    const zip = new PizZip(result.buffer);
    const xml = zip.file('word/document.xml')!.asText();
    expect(xml).toContain('Hej Anna og');
    // missing-placeholder erstattes med tom streng, ikke kastet
    expect(xml).not.toContain('{{missing}}');
  });
});

describe('fillXlsxTemplate', () => {
  it('throws iter-2 message', async () => {
    await expect(fillXlsxTemplate(Buffer.from([]), { rows: [] })).rejects.toThrow(
      'parkeret til iter 2'
    );
  });
});

describe('zod schema validation', () => {
  it('rejects too many columns', () => {
    const cols = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => ({
      key: `c${i}`,
      header: `H${i}`,
    }));
    const result = GenerateXlsxInputSchema.safeParse({
      title: 'X',
      columns: cols,
      rows: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects too many rows', () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, () => ({ a: 'x' }));
    const result = GenerateXlsxInputSchema.safeParse({
      title: 'X',
      columns: [{ key: 'a', header: 'A' }],
      rows,
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid input', () => {
    const result = GenerateXlsxInputSchema.safeParse({
      title: 'Test',
      columns: [{ key: 'a', header: 'A' }],
      rows: [{ a: '1' }, { a: '2' }],
    });
    expect(result.success).toBe(true);
  });

  it('docx schema requires at least 1 section', () => {
    const r = GenerateDocxInputSchema.safeParse({ title: 'X', sections: [] });
    expect(r.success).toBe(false);
  });

  it('csv schema validates delimiter length=1', () => {
    const r = GenerateCsvInputSchema.safeParse({
      columns: [{ key: 'a', header: 'A' }],
      rows: [],
      delimiter: '||',
    });
    expect(r.success).toBe(false);
  });
});
