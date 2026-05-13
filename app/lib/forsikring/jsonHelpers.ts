/**
 * Pure helpers for parsing AI-returned JSON og filtype-routing.
 *
 * Holdes som separat fil så unit-tests kan importere uden at trigge
 * den tunge dependency-chain fra parser.ts (Anthropic SDK, pdf-parse,
 * mailparser dynamic imports etc.).
 *
 * @module app/lib/forsikring/jsonHelpers
 */

import type { NormalizedFileType } from '@/app/lib/domainFileTypes';

/**
 * Filtyper som forsikrings-parseren kan behandle via tekst-ekstraktion
 * (modsat billed-parsing via Claude vision).
 */
export const TEXT_FILE_TYPES: readonly NormalizedFileType[] = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'rtf',
  'txt',
  'md',
  'html',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'log',
  'code',
  'eml',
];

/**
 * Test om en filtype kan parses tekstuelt af parser.ts.
 *
 * @param type - NormalizedFileType
 * @returns true hvis filtypen kan tekst-ekstraheres
 */
export function canParseAsText(type: NormalizedFileType): boolean {
  return TEXT_FILE_TYPES.includes(type);
}

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
