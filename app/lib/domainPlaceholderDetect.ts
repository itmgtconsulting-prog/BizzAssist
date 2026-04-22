/**
 * BIZZ-707: Placeholder detection for domain templates.
 *
 * Scans extracted template text and returns unique placeholder tokens
 * along with a short context snippet so the template-editor UI
 * (BIZZ-721) can render a preview next to each placeholder when the
 * author reviews what was detected.
 *
 * Supported syntaxes:
 *   {{navn}}     — Mustache-style (recommended — matches docxtemplater)
 *   {navn}       — Single-brace (only when not part of JSON-like structures)
 *   [FELT]       — Bracket-style (uppercase convention)
 *   [[FELT]]     — Double-bracket for compatibility with some systems
 *
 * Single-brace {…} is prone to false positives (code snippets, JSON),
 * so we only match when the content is identifier-like (letters, digits,
 * underscore, hyphen, dot) and at least 2 chars long.
 *
 * @module app/lib/domainPlaceholderDetect
 */

/** Maximum placeholders to return — bounds memory on very large docs. */
export const MAX_PLACEHOLDERS = 500;

/** Maximum context snippet length (chars before + after the placeholder). */
const CONTEXT_WINDOW = 40;

export interface DetectedPlaceholder {
  /** Normalised name (no braces, no whitespace) */
  name: string;
  /** Raw token as it appears in the text (with braces) */
  raw: string;
  /** Short surrounding context (up to 2 * CONTEXT_WINDOW chars) */
  context: string;
  /** Syntax style used in the template */
  syntax: 'mustache' | 'single-brace' | 'bracket' | 'double-bracket';
  /** Number of occurrences in the document */
  count: number;
}

const PATTERNS: Array<{ re: RegExp; syntax: DetectedPlaceholder['syntax'] }> = [
  // {{name}} — mustache; 1+ chars to allow short identifiers
  { re: /\{\{([a-zA-ZæøåÆØÅ0-9_.-]+)\}\}/g, syntax: 'mustache' },
  // [[FELT]] — double-bracket, any identifier
  { re: /\[\[([a-zA-ZæøåÆØÅ0-9_.-]+)\]\]/g, syntax: 'double-bracket' },
  // [FELT] — single-bracket, uppercase-first convention (lowercase avoided
  // to reduce false positives from [note], [see] etc.)
  { re: /\[([A-ZÆØÅ][A-ZÆØÅ0-9_.-]*)\]/g, syntax: 'bracket' },
  // {navn} — single-brace; more restrictive (start with letter, 2+ chars)
  // to avoid false positives in code / JSON fragments.
  { re: /\{([a-zA-ZæøåÆØÅ][a-zA-ZæøåÆØÅ0-9_-]+)\}/g, syntax: 'single-brace' },
];

/**
 * Scans text for placeholder tokens and returns unique placeholders with
 * context + count, ordered by first appearance in the document.
 *
 * @param text - Extracted template text
 */
export function detectPlaceholders(text: string): DetectedPlaceholder[] {
  if (!text) return [];

  // Step 1: collect every raw match from every pattern with its index span.
  // We'll dedupe overlapping matches in step 2 so {{navn}} isn't double-
  // counted by the single-brace pattern matching {navn} inside.
  type RawHit = {
    raw: string;
    name: string;
    syntax: DetectedPlaceholder['syntax'];
    start: number;
    end: number;
  };
  const hits: RawHit[] = [];
  for (const { re, syntax } of PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      hits.push({
        raw: match[0],
        name: match[1].trim(),
        syntax,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  if (hits.length === 0) return [];

  // Step 2: drop hits that are strictly contained within a longer hit at
  // the same position — this collapses {{name}} (mustache) vs {name}
  // (single-brace) into the single mustache match. Keep the outer, wider
  // match since it represents the intended placeholder syntax.
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: RawHit[] = [];
  for (const h of hits) {
    const overlapping = kept.find((k) => k.start <= h.start && k.end >= h.end && k !== h);
    if (overlapping) continue;
    kept.push(h);
  }

  // Step 3: group by name to build the final DetectedPlaceholder list —
  // a placeholder that appears via multiple syntaxes merges into one entry
  // with the first-seen raw/syntax and combined count.
  const byName = new Map<string, DetectedPlaceholder & { firstIndex: number }>();
  for (const h of kept) {
    const existing = byName.get(h.name);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const ctxStart = Math.max(0, h.start - CONTEXT_WINDOW);
    const ctxEnd = Math.min(text.length, h.end + CONTEXT_WINDOW);
    byName.set(h.name, {
      name: h.name,
      raw: h.raw,
      context: text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim(),
      syntax: h.syntax,
      count: 1,
      firstIndex: h.start,
    });
    if (byName.size >= MAX_PLACEHOLDERS) break;
  }

  const sorted = [...byName.values()].sort((a, b) => a.firstIndex - b.firstIndex);
  return sorted.map(({ firstIndex: _firstIndex, ...rest }) => rest);
}
