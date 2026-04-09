/**
 * Service Manager — Auto-Approval Rules
 *
 * Defines the rule set that determines whether a proposed fix can be
 * automatically approved without explicit admin review, and provides
 * a helper to persist auto-approval audit entries.
 *
 * Rules are evaluated in priority order; the first matching rule wins.
 * A fix is only auto-approved if ALL of the following hold:
 *   - The fix is classified as 'bug-fix' or 'config-fix'
 *   - A rule explicitly matches the issue + diff combination
 *   - The diff is within the rule's line-count limit
 *
 * @module lib/service-manager-rules
 */

import { createAdminClient } from '@/lib/supabase/admin';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal shape of a ScanIssue — mirrors the full type in
 * app/api/admin/service-manager/route.ts without creating a circular dep.
 */
interface ScanIssue {
  type: 'build_error' | 'runtime_error' | 'type_error' | 'config_error';
  severity: 'error' | 'warning';
  message: string;
  source: 'vercel_build' | 'vercel_logs' | 'static';
  context?: string;
}

/**
 * Result returned by {@link evaluateAutoApproval}.
 */
export interface AutoApprovalResult {
  /** Whether the fix should be automatically approved. */
  autoApprove: boolean;
  /** Internal name of the matching rule, if any. */
  ruleName?: string;
  /** Human-readable description of why the rule matched. */
  ruleDescription?: string;
}

/**
 * A single auto-approval rule definition.
 */
interface AutoApprovalRule {
  /** Unique identifier used in audit log entries. */
  name: string;
  /** Human-readable description shown in the admin panel. */
  description: string;
  /** Maximum lines changed (inclusive) for this rule to apply. */
  maxLines: number;
  /**
   * Predicate that determines whether this rule matches a given fix.
   *
   * @param issue - The scan issue being fixed.
   * @param diff - The proposed unified diff.
   * @param classification - Claude's classification of the fix.
   * @returns true if this rule approves the fix.
   */
  matches(issue: ScanIssue, diff: string, classification: string): boolean;
}

// ─── Rule definitions ─────────────────────────────────────────────────────────

/**
 * Ordered list of auto-approval rules.
 * Evaluated top-to-bottom; first match wins.
 *
 * Guiding principle: auto-approve ONLY for changes that are:
 *   1. Trivially verifiable by a human in < 30 seconds
 *   2. Extremely unlikely to introduce new bugs
 *   3. Isolated to a single well-understood pattern
 */
const AUTO_APPROVAL_RULES: AutoApprovalRule[] = [
  {
    name: 'missing-import-fix',
    description:
      'Tilføjer en manglende import-linje for et allerede eksisterende modul (≤ 3 linjer ændret).',
    maxLines: 3,
    matches(issue, diff, classification) {
      if (classification !== 'bug-fix') return false;
      // Issue message must reference a missing module / import
      const msgLower = issue.message.toLowerCase();
      if (
        !msgLower.includes('module not found') &&
        !msgLower.includes('cannot find module') &&
        !msgLower.includes('import') &&
        issue.type !== 'type_error'
      ) {
        return false;
      }
      // Diff must only add import lines (lines starting with +import)
      const addedLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
      return addedLines.every((l) => /^\+\s*import\b/.test(l) || /^\+\s*\/\//.test(l));
    },
  },
  {
    name: 'null-check-fix',
    description:
      'Adds optional chaining or a null guard to prevent a TypeError (≤ 5 linjer ændret).',
    maxLines: 5,
    matches(issue, diff, classification) {
      if (classification !== 'bug-fix') return false;
      const msgLower = issue.message.toLowerCase();
      if (
        !msgLower.includes('cannot read properties') &&
        !msgLower.includes('null') &&
        !msgLower.includes('undefined') &&
        !msgLower.includes('typeerror')
      ) {
        return false;
      }
      // Diff should introduce optional chaining (?.) or nullish coalescing (??)
      return diff.includes('?.') || diff.includes('?? ') || diff.includes('??\n');
    },
  },
  {
    name: 'env-var-typo-fix',
    description: 'Corrects a misspelled environment variable name (config-fix, ≤ 4 linjer ændret).',
    maxLines: 4,
    matches(issue, diff, classification) {
      if (classification !== 'config-fix') return false;
      const msgLower = issue.message.toLowerCase();
      return (
        msgLower.includes('env') ||
        msgLower.includes('environment') ||
        msgLower.includes('process.env') ||
        issue.type === 'config_error'
      );
    },
  },
  {
    name: 'build_fix',
    description:
      'Auto-approves a bug-fix for a build error when the diff only touches TypeScript types, ' +
      'imports, or config values — no logic changes (≤ 15 linjer ændret). ' +
      'When matched, the Release Agent is triggered to create a hotfix branch and PR.',
    maxLines: 15,
    matches(issue, diff, classification) {
      // Only applies to build errors classified as bug-fix
      if (classification !== 'bug-fix') return false;
      if (issue.type !== 'build_error') return false;

      // Extract all changed lines (strip the +/- prefix, ignore diff headers)
      const changedLines = diff
        .split('\n')
        .filter(
          (l) =>
            (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('---') && !l.startsWith('+++')
        )
        .map((l) => l.slice(1).trim());

      if (changedLines.length === 0) return false;

      /**
       * A changed line is considered "safe" (types/imports/config) if it matches
       * one of the following patterns. Logic-bearing code (conditionals, function
       * calls, assignments with complex RHS) does not match and causes rejection.
       */
      const isSafeLine = (line: string): boolean => {
        if (line === '') return true;
        // Comments
        if (/^\/\//.test(line) || /^\/\*/.test(line) || /^\*/.test(line)) return true;
        // Import statements (including multi-line continuations)
        if (/^import\b/.test(line)) return true;
        if (/^from\s+['"]/.test(line)) return true;
        // Re-export type statements
        if (/^export\s+(?:type\s+)?\{/.test(line)) return true;
        if (/^export\s+type\b/.test(line)) return true;
        // TypeScript type / interface declarations
        if (/^type\s+\w+/.test(line)) return true;
        if (/^interface\s+\w+/.test(line)) return true;
        // Closing braces for type blocks (interface bodies, type unions, etc.)
        if (/^[}\]]\s*[;,]?\s*$/.test(line)) return true;
        if (/^\|\s+\w/.test(line)) return true; // union type member
        // Config file JSON-style key-value (tsconfig, next.config values)
        if (/^["']?\w[\w-]*["']?\s*:\s*(?:true|false|null|['"\d\[{])/.test(line)) return true;
        // Simple string/number constant declarations (no function calls)
        if (/^(?:const|let|var)\s+\w+\s*=\s*['"`\d]/.test(line)) return true;

        return false;
      };

      return changedLines.every(isSafeLine);
    },
  },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate whether a proposed fix qualifies for automatic approval.
 *
 * Only fixes classified as 'bug-fix' or 'config-fix' are considered;
 * 'rejected' fixes always return { autoApprove: false }.
 *
 * @param issue - The scan issue being fixed.
 * @param diff - The proposed unified diff string.
 * @param lineCount - Pre-computed count of changed lines.
 * @param classification - Claude's fix classification.
 * @returns Auto-approval decision and the matched rule, if any.
 */
export function evaluateAutoApproval(
  issue: ScanIssue,
  diff: string,
  lineCount: number,
  classification: string
): AutoApprovalResult {
  // Never auto-approve rejected fixes
  if (classification === 'rejected') {
    return { autoApprove: false };
  }

  for (const rule of AUTO_APPROVAL_RULES) {
    if (lineCount > rule.maxLines) continue;
    if (rule.matches(issue, diff, classification)) {
      return {
        autoApprove: true,
        ruleName: rule.name,
        ruleDescription: rule.description,
      };
    }
  }

  return { autoApprove: false };
}

/**
 * Persist an auto-approval audit entry to service_manager_activity.
 * Failures are non-fatal — the caller continues even if logging fails.
 *
 * @param fixId - UUID of the fix record that was auto-approved.
 * @param scanId - UUID of the parent scan.
 * @param ruleName - Name of the rule that triggered auto-approval.
 * @param ruleDescription - Human-readable rule description.
 * @param metadata - Additional context fields to include in the log entry.
 */
export async function logAutoApproval(
  fixId: string,
  scanId: string,
  ruleName: string,
  ruleDescription: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await createAdminClient().from('service_manager_activity').insert({
      action: 'auto_approval_triggered',
      details: {
        fix_id: fixId,
        scan_id: scanId,
        rule_name: ruleName,
        rule_description: ruleDescription,
        ...metadata,
      },
      created_by: null, // System action — no user session
    });
  } catch (err) {
    console.error('[service-manager-rules] logAutoApproval error:', err);
  }
}
