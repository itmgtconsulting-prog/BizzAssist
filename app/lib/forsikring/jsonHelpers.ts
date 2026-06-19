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

/**
 * BIZZ-2081: Red komplette police-objekter fra et JSON-svar der blev afkortet
 * ved max_tokens. Finder "policies"-arrayet og afskærer ved det sidste
 * komplette objekt (balancerede brackets uden for strenge), lukker derefter
 * array + rod-objekt og parser igen.
 *
 * @param truncated - Det afkortede (ugyldige) JSON-output fra Claude
 * @returns Objekt med de reddede policer, eller null hvis intet kan reddes
 */
export function salvageTruncatedOversigt(
  truncated: string
): { policies: unknown[]; broker_name: null; overview_date: null; notes: string } | null {
  const arrStart = truncated.indexOf('"policies"');
  if (arrStart === -1) return null;
  const bracket = truncated.indexOf('[', arrStart);
  if (bracket === -1) return null;

  // Scan tegn for tegn og husk positionen efter hvert komplet top-level objekt
  // i arrayet. Strenge (inkl. escapes) skal ignoreres i bracket-tællingen.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastCompleteEnd = -1;
  for (let i = bracket + 1; i < truncated.length; i++) {
    const ch = truncated[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && ch === '}') lastCompleteEnd = i;
      if (depth < 0) break; // arrayet blev lukket — burde have parset normalt
    }
  }
  if (lastCompleteEnd === -1) return null;

  const arrayJson = truncated.slice(bracket, lastCompleteEnd + 1) + ']';
  try {
    const policies = JSON.parse(arrayJson) as unknown[];
    if (!Array.isArray(policies) || policies.length === 0) return null;
    return {
      policies,
      broker_name: null,
      overview_date: null,
      notes: 'Oversigten var for lang til fuld parsing — de sidste policer kan mangle.',
    };
  } catch {
    return null;
  }
}
