/**
 * BIZZ-715: Paragraph-aware text chunking for domain embeddings.
 *
 * Splits extracted document text into chunks of ~800 tokens with 100-token
 * overlap. Prefers paragraph boundaries; falls back to sentence boundaries
 * when a paragraph itself exceeds the cap. Uses a simple chars/4 heuristic
 * for token approximation — good enough for Danish prose without pulling in
 * a tiktoken dependency.
 *
 * @module app/lib/domainChunker
 */

/** Target tokens per chunk (BIZZ-715 spec: 800). */
export const CHUNK_SIZE_TOKENS = 800;
/** Token overlap between consecutive chunks (BIZZ-715 spec: 100). */
export const CHUNK_OVERLAP_TOKENS = 100;
/** Chars-per-token heuristic — reasonable for Danish/English prose. */
const CHARS_PER_TOKEN = 4;

const CHUNK_SIZE_CHARS = CHUNK_SIZE_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN;

export interface TextChunk {
  /** Index in the order they were produced (0-based) */
  index: number;
  /** The chunk text */
  text: string;
  /** Starting char offset in the source text */
  startOffset: number;
  /** Stable SHA-256 hash of the text — used for incremental re-embedding */
  hash: string;
}

/**
 * Compute a stable content hash for a chunk — lets incremental embedding
 * skip chunks that haven't changed since the last run.
 */
async function sha256(text: string): Promise<string> {
  // Web Crypto API is available in both Node 22+ and edge runtimes
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Split text into overlapping chunks. Paragraph boundaries (double newline)
 * are preferred; when a paragraph is too large, we fall back to splitting at
 * sentence boundaries (. ! ?); oversized sentences are hard-cut at the char
 * cap so we never exceed the budget.
 *
 * @param text - Full extracted document text
 * @returns Array of chunks with content hashes for incremental re-embedding
 */
export async function chunkText(text: string): Promise<TextChunk[]> {
  if (!text || text.trim().length === 0) return [];

  // Normalise whitespace + split into paragraphs
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: TextChunk[] = [];
  let buffer = '';
  let bufferStart = 0;

  const flushBuffer = async () => {
    if (!buffer.trim()) return;
    chunks.push({
      index: chunks.length,
      text: buffer.trim(),
      startOffset: bufferStart,
      hash: await sha256(buffer.trim()),
    });
    // Carry over the last OVERLAP_CHARS as seed for the next chunk
    const overlap = buffer.slice(Math.max(0, buffer.length - OVERLAP_CHARS));
    buffer = overlap;
    bufferStart = bufferStart + buffer.length - overlap.length;
  };

  const appendParagraph = async (p: string) => {
    // If adding p would blow the cap, flush first — but only if the buffer
    // already has non-overlap content (avoid infinite flush loop).
    if (buffer.length > OVERLAP_CHARS && buffer.length + p.length + 2 > CHUNK_SIZE_CHARS) {
      await flushBuffer();
    }
    // Still too big? Paragraph itself exceeds the cap — split on sentences.
    if (p.length > CHUNK_SIZE_CHARS) {
      const sentences = p.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (s.length > CHUNK_SIZE_CHARS) {
          // Oversized sentence — hard-cut
          for (let i = 0; i < s.length; i += CHUNK_SIZE_CHARS - OVERLAP_CHARS) {
            buffer += (buffer ? ' ' : '') + s.slice(i, i + CHUNK_SIZE_CHARS);
            if (buffer.length >= CHUNK_SIZE_CHARS) await flushBuffer();
          }
        } else {
          if (buffer.length > OVERLAP_CHARS && buffer.length + s.length + 1 > CHUNK_SIZE_CHARS) {
            await flushBuffer();
          }
          buffer += (buffer ? ' ' : '') + s;
        }
      }
      return;
    }
    buffer += (buffer ? '\n\n' : '') + p;
  };

  for (const p of paragraphs) {
    await appendParagraph(p);
  }
  await flushBuffer();

  return chunks;
}
