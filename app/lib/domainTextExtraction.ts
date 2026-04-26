/**
 * BIZZ-714 / BIZZ-788: Text extraction from domain documents.
 *
 * Converts uploaded case/training/template files into a plain-text
 * representation that the AI generation pipeline (BIZZ-716/717) can feed
 * into Claude without re-parsing on every call.
 *
 * Supported formats:
 *   Office (server-side parsed):
 *     - .docx  — mammoth (convertToHtml → text)
 *     - .xlsx  — exceljs (worksheet → CSV-like text)
 *     - .pptx  — jszip (slides xml → text extraction)
 *     - .rtf   — strip control words to plain text
 *   Documents:
 *     - .pdf   — pdf-parse (text layer only; no OCR)
 *   Plain-text / structured (direct UTF-8 decode, preserved verbatim):
 *     - .txt .md .html .csv .tsv .json .xml .yaml .log .code
 *   Email:
 *     - .eml   — mailparser (headers + body)
 *     - .msg   — Not yet supported (msgreader isn't in deps); clear error
 *   Images:
 *     - image  — skipped here; callers send bytes directly via vision
 *
 * @module app/lib/domainTextExtraction
 */

import { logger } from '@/app/lib/logger';
import type { NormalizedFileType } from '@/app/lib/domainFileTypes';

/** Legacy alias kept for call-sites not yet migrated. Prefer NormalizedFileType. */
export type DomainFileType = NormalizedFileType;

/** Max characters to store in extracted_text — avoids oversize rows. */
export const MAX_EXTRACTED_CHARS = 500_000;

export type ExtractionResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Extracts plain text from a document buffer.
 * Never throws — wraps all parser failures in { ok: false, error }.
 *
 * @param buffer - Raw file bytes
 * @param type - File type (must match domain_case_doc.file_type)
 * @returns Extraction result
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  type: DomainFileType
): Promise<ExtractionResult> {
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'Empty file' };
  }

  try {
    let text: string;
    switch (type) {
      // Plain-text family — UTF-8 decode, preserve content verbatim.
      case 'txt':
      case 'md':
      case 'csv':
      case 'tsv':
      case 'json':
      case 'xml':
      case 'yaml':
      case 'log':
      case 'code':
        text = buffer.toString('utf8');
        break;
      case 'html':
        // Strip tags/scripts so Claude doesn't waste tokens on markup.
        text = buffer
          .toString('utf8')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        break;
      case 'rtf':
        // Extremely minimal RTF → text: strip control words + braces.
        // Good enough for ~95% of real-world rtf files.
        text = buffer
          .toString('utf8')
          .replace(/\\par[d]?/g, '\n')
          .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
          .replace(/[{}]/g, '')
          .replace(/\\\n/g, '\n');
        break;
      case 'docx': {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        text = String(result.value ?? '');
        break;
      }
      case 'xlsx': {
        // exceljs — iterate workbook, output each sheet as headed CSV-like
        // plain text so Claude can read tabular data.
        const ExcelJS = await import('exceljs');
        const wb = new ExcelJS.Workbook();
        // exceljs's typing insists on ArrayBuffer, but the runtime accepts
        // any buffer-like input. Cast through unknown to avoid a needless
        // Uint8Array -> ArrayBuffer copy.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await wb.xlsx.load(buffer as unknown as any);
        const sections: string[] = [];
        wb.eachSheet((sheet) => {
          const lines: string[] = [`# ${sheet.name}`];
          sheet.eachRow({ includeEmpty: false }, (row) => {
            const cells: string[] = [];
            row.eachCell({ includeEmpty: true }, (cell) => {
              const v = cell.value;
              if (v === null || v === undefined) {
                cells.push('');
              } else if (typeof v === 'object' && 'text' in v) {
                // Rich-text / formula result object
                cells.push(
                  String(
                    (v as { text?: string; result?: unknown }).text ??
                      (v as { result?: unknown }).result ??
                      ''
                  )
                );
              } else if (v instanceof Date) {
                cells.push(v.toISOString());
              } else {
                cells.push(String(v));
              }
            });
            lines.push(cells.join('\t'));
          });
          sections.push(lines.join('\n'));
        });
        text = sections.join('\n\n');
        break;
      }
      case 'pptx': {
        // pptx is a zip archive — read each slide's XML + strip tags.
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(buffer);
        const slideFiles = Object.keys(zip.files)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => {
            const na = parseInt(a.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10);
            const nb = parseInt(b.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10);
            return na - nb;
          });
        const parts: string[] = [];
        for (let i = 0; i < slideFiles.length; i++) {
          const xml = await zip.file(slideFiles[i])!.async('string');
          // Grab text nodes: <a:t>...</a:t>
          const texts: string[] = [];
          const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(xml)) !== null) {
            texts.push(
              m[1]
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
            );
          }
          parts.push(`--- Slide ${i + 1} ---\n` + texts.join('\n'));
        }
        text = parts.join('\n\n');
        break;
      }
      case 'pdf': {
        // pdf-parse's ESM entry re-exports as a namespace; pdfParse is the
        // default export in CJS, PDF in ESM. Call whichever is callable.
        const mod = await import('pdf-parse');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = ((mod as any).default ?? (mod as any).PDF ?? mod) as (
          buf: Buffer
        ) => Promise<{ text: string }>;
        const result = await fn(buffer);
        text = String(result.text ?? '');
        break;
      }
      case 'eml': {
        const { simpleParser } = await import('mailparser');
        const parsed = await simpleParser(buffer);
        const header = [
          parsed.subject ? `Subject: ${parsed.subject}` : null,
          parsed.from?.text ? `From: ${parsed.from.text}` : null,
          parsed.to
            ? `To: ${Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to.text}`
            : null,
          parsed.date ? `Date: ${parsed.date.toISOString()}` : null,
        ]
          .filter(Boolean)
          .join('\n');
        const body = parsed.text || parsed.textAsHtml || '';
        text = header + (header && body ? '\n\n' : '') + body;
        break;
      }
      case 'msg':
        return {
          ok: false,
          error:
            '.msg-filer er endnu ikke understøttet af text-extraction. Konvertér til .eml eller .pdf.',
        };
      case 'image':
        // Images are sent to Claude via vision, not tekst-ekstraheret.
        // Callers should skip this path for images; return a clear signal.
        return {
          ok: false,
          error: 'Images bruges via vision — ingen tekst-ekstraktion.',
        };
      default:
        return { ok: false, error: `Unsupported file type: ${type as string}` };
    }

    // Normalise whitespace: collapse >2 consecutive newlines, trim
    const normalised = text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const truncated = normalised.length > MAX_EXTRACTED_CHARS;
    const final = truncated ? normalised.slice(0, MAX_EXTRACTED_CHARS) : normalised;
    return { ok: true, text: final, truncated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[domain/extract] ${type} parse failed:`, msg);
    return { ok: false, error: `Parse error: ${msg}` };
  }
}
