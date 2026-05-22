#!/usr/bin/env node
/**
 * PII Leak Audit — scanner kodebase for potentielle PII-patterns.
 *
 * BIZZ-1706: Køres i pre-commit hook + CI.
 * Exit code 1 hvis PII-patterns fundet.
 *
 * Brug:
 *   node scripts/audit-pii-leak.mjs [--fix]
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const IGNORE_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'coverage',
  'playwright-evidence', '.claude',
]);
const IGNORE_FILES = new Set([
  'audit-pii-leak.mjs', // dette script
  'piiRedact.ts',       // redact-utility (legitimt brug)
  'piiRedact.test.ts',  // tests for redact
]);

// PII-patterns at scanne for
const PII_PATTERNS = [
  {
    name: 'CPR-nummer (hardcoded)',
    // Matcher 6+4 cifre der ligner CPR (ikke i kommentarer/strings om regex)
    regex: /(?<!\w)(?<!['"\/])(\d{6})-?(\d{4})(?!\w)/g,
    validate: (match) => {
      const day = parseInt(match.slice(0, 2), 10);
      const month = parseInt(match.slice(2, 4), 10);
      // Kun flag hvis det ligner en reel CPR-dato
      return month >= 1 && month <= 12 && day >= 1 && day <= 31;
    },
    // Skip i test-filer og fixtures
    skipInTests: true,
  },
  {
    name: 'CPR variabel-navn',
    regex: /\b(cprNummer|cprNumber|CPRNummer|personIdentifier|personnummer)\b/g,
    validate: () => true,
    skipInTests: false,
  },
];

/** Rekursiv fil-iterator */
function* walkFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkFiles(full);
    } else if (EXTENSIONS.has(extname(entry)) && !IGNORE_FILES.has(entry)) {
      yield full;
    }
  }
}

let violations = 0;

for (const filePath of walkFiles(process.cwd())) {
  const content = readFileSync(filePath, 'utf8');
  const relPath = filePath.replace(process.cwd() + '/', '');
  const isTest = relPath.includes('__tests__') || relPath.includes('.test.') || relPath.includes('.spec.');

  for (const pattern of PII_PATTERNS) {
    if (pattern.skipInTests && isTest) continue;

    let match;
    pattern.regex.lastIndex = 0;
    while ((match = pattern.regex.exec(content)) !== null) {
      // Skip matches inside comments or string literals about regex patterns
      const lineStart = content.lastIndexOf('\n', match.index) + 1;
      const line = content.slice(lineStart, content.indexOf('\n', match.index));

      // Skip if it's in a regex pattern definition or comment about PII
      if (line.includes('regex') || line.includes('pattern') || line.includes('match') ||
          line.includes('replace') || line.includes('test(') || line.includes('REDACT')) {
        continue;
      }

      if (pattern.validate(match[0])) {
        const lineNum = content.slice(0, match.index).split('\n').length;
        console.error(`  ❌ ${relPath}:${lineNum} — ${pattern.name}: "${match[0]}"`);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} PII violation(s) found. Fix before committing.`);
  process.exit(1);
} else {
  console.log('✅ No PII patterns found in codebase.');
}
