/**
 * Pure helpers for parsing AI-returned JSON.
 *
 * Holdes som separat fil så unit-tests kan importere uden at trigge
 * den tunge dependency-chain fra parser.ts (Anthropic SDK, pdf-parse,
 * mailparser dynamic imports etc.).
 *
 * @module app/lib/forsikring/jsonHelpers
 */

/**
 * Fjern Markdown code-fences hvis Claude inkluderer dem.
 * Tolerér både ```json og bare ``` prefixes samt vilkårlig whitespace.
 *
 * @param raw - Rå tekst fra Claude
 * @returns Tekst uden fences (trimmed)
 */
export function stripMarkdownFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    const firstNewline = s.indexOf('\n');
    if (firstNewline !== -1) {
      s = s.slice(firstNewline + 1);
    }
  }
  if (s.endsWith('```')) {
    s = s.slice(0, -3).trimEnd();
  }
  return s.trim();
}
