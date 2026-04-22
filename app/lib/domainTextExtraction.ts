/**
 * BIZZ-714: Text extraction from domain documents.
 *
 * Converts uploaded case/training/template files into a plain-text
 * representation that the AI generation pipeline (BIZZ-716/717) can feed
 * into Claude without re-parsing on every call.
 *
 * Supported formats (matches domain_case_doc.file_type check constraint):
 *   - .docx — mammoth (convertToHtml → text)
 *   - .pdf  — pdf-parse (text layer only; no OCR)
 *   - .txt  — direct UTF-8 decode
 *   - .eml  — mailparser (headers + body)
 *   - .msg  — Not yet supported (msgreader isn't in deps); reports a clear error
 *
 * @module app/lib/domainTextExtraction
 */

import { logger } from '@/app/lib/logger';

export type DomainFileType = 'docx' | 'pdf' | 'txt' | 'eml' | 'msg';

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
      case 'txt':
        text = buffer.toString('utf8');
        break;
      case 'docx': {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        text = String(result.value ?? '');
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
      default:
        return { ok: false, error: `Unsupported file type: ${type}` };
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
