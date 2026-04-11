/**
 * Service Manager Auto-Approval Rules — app/lib/service-manager-rules.ts
 *
 * Defines the rules engine that determines whether a proposed fix can be
 * automatically approved without admin review. Rules are intentionally
 * conservative — only the most mechanical, low-risk fix types are eligible.
 *
 * Adding a new rule: push a new entry to AUTO_APPROVAL_RULES with a unique
 * `name` and the appropriate `test` function. The engine evaluates rules in
 * order and returns on the first match.
 *
 * IMPORTANT: This module is SERVER-SIDE ONLY. Never import in Client Components.
 *
 * @module lib/service-manager-rules
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The minimal shape of a scan issue needed by the rules engine.
 * Mirrors ScanIssue from the service-manager scan routes.
 */
export interface RuleIssue {
  type: 'build_error' | 'runtime_error' | 'type_error' | 'config_error';
  severity: 'error' | 'warning';
  message: string;
  source: string;
  context?: string;
}

/**
 * Input supplied to each rule's `test` function.
 */
export interface RuleInput {
  /** The scan issue being evaluated */
  issue: RuleIssue;
  /** The unified diff proposed by Claude */
  diff: string;
  /** Pre-computed count of changed lines (additions + deletions) */
  lineCount: number;
  /** Fix classification from Claude: 'bug-fix' | 'config-fix' */
  classification: string;
}

/**
 * A single auto-approval rule.
 */
export interface AutoApprovalRule {
  /** Unique identifier — logged to service_manager_activity when matched */
  name: string;
  /** Human-readable description shown in the audit log */
  description: string;
  /**
   * Returns true if this rule's conditions are satisfied and the fix
   * should be automatically approved.
   */
  test: (input: RuleInput) => boolean;
}

/**
 * Result returned by {@link evaluateAutoApproval}.
 */
export interface AutoApprovalResult {
  /** Whether the fix qualifies for automatic approval */
  autoApprove: boolean;
  /** Name of the matched rule, or undefined if no rule matched */
  ruleName?: string;
  /** Description of the matched rule for audit logging */
  ruleDescription?: string;
}

// ─── Diff analysis helpers ────────────────────────────────────────────────────

/**
 * Extract only the added/removed lines from a unified diff (not headers).
 *
 * @param diff - Unified diff string.
 * @returns Array of changed lines, each starting with '+' or '-'.
 */
function changedLines(diff: string): string[] {
  return diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('---') &&
        !line.startsWith('+++')
    );
}

/**
 * Return true if ALL changed lines in the diff touch only import statements.
 * Matches ES module imports and CommonJS require() calls.
 *
 * @param diff - Unified diff string.
 */
function isImportOnlyDiff(diff: string): boolean {
  const lines = changedLines(diff);
  if (lines.length === 0) return false;
  // Each changed line (stripped of leading +/-) must be an import/require or blank
  return lines.every((line) => {
    const content = line.slice(1).trim();
    return (
      content === '' ||
      /^import\s/.test(content) ||
      /^}\s*from\s+['"]/.test(content) || // closing brace of a multi-line import
      /^require\s*\(/.test(content) ||
      /^\s*['"][^'"]+['"]\s*,?\s*$/.test(content) // named import list item
    );
  });
}

/**
 * Return true if ALL changed lines in the diff touch only string literals
 * or comment lines (single-line // and multi-line /* style).
 *
 * @param diff - Unified diff string.
 */
function isStringOrCommentOnlyDiff(diff: string): boolean {
  const lines = changedLines(diff);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const content = line.slice(1).trim();
    return (
      content === '' ||
      content.startsWith('//') ||
      content.startsWith('*') ||
      content.startsWith('/*') ||
      content.startsWith('*/') ||
      // String literal lines: starts and/or ends with a quote (inside template/concat)
      /^['"`]/.test(content) ||
      /['"`][,;]?\s*$/.test(content) ||
      // Pure string assignment: const/let foo = '...'
      /^(?:const|let|var)\s+\w+\s*=\s*['"`]/.test(content)
    );
  });
}

/**
 * Return true if ALL changed lines relate to environment variable access or
 * configuration values (process.env references, config object literals,
 * header values, feature flags expressed as booleans/strings).
 * Excludes lines that contain function definitions, control flow, or JSX.
 *
 * @param diff - Unified diff string.
 */
function isConfigOnlyDiff(diff: string): boolean {
  const lines = changedLines(diff);
  if (lines.length === 0) return false;

  // Patterns that indicate config-only content
  const CONFIG_PATTERNS: RegExp[] = [
    /process\.env\.\w+/,
    /^(?:const|let|var)\s+\w+\s*=\s*process\.env/,
    /['"`]\s*\?\?\s*['"`]/, // nullish coalescing with string fallback
    /^export\s+const\s+\w+\s*=\s*(?:process\.env|['"`\d])/, // exported config const
    /^\s*\w+:\s*process\.env/, // object property: value = env var
    /^\s*\w+:\s*['"`][^'"`]*['"`]\s*,?\s*$/, // plain string property
    /^\s*\/\/.*$/, // comment line
  ];

  // Patterns that disqualify a line from being "config-only"
  const DISQUALIFY_PATTERNS: RegExp[] = [
    /\bfunction\b/,
    /=>/,
    /\bif\b|\belse\b|\bwhile\b|\bfor\b|\bswitch\b/,
    /<[A-Z][a-zA-Z]*/, // JSX component
    /\breturn\b.*\(/, // return with complex expression
  ];

  return lines.every((line) => {
    const content = line.slice(1).trim();
    if (content === '') return true;
    if (DISQUALIFY_PATTERNS.some((p) => p.test(content))) return false;
    return CONFIG_PATTERNS.some((p) => p.test(content));
  });
}

// ─── Rule definitions ─────────────────────────────────────────────────────────

/**
 * Ordered list of auto-approval rules.
 *
 * Rules are evaluated in array order. The first rule whose `test` returns true
 * wins. If no rule matches, the fix requires manual admin review.
 *
 * To add a rule: push a new entry. Rule names must be unique — they are stored
 * verbatim in the audit log.
 */
export const AUTO_APPROVAL_RULES: AutoApprovalRule[] = [
  // ── Rule 1: Config-only fixes ──────────────────────────────────────────────
  {
    name: 'config_only_fix',
    description: 'Env var or config value change only, no logic — under 10 lines. Auto-approved.',
    test: ({ classification, diff, lineCount }: RuleInput): boolean => {
      if (classification !== 'config-fix') return false;
      if (lineCount > 10) return false;
      return isConfigOnlyDiff(diff);
    },
  },

  // ── Rule 2: Import fixes ───────────────────────────────────────────────────
  {
    name: 'import_fix',
    description: 'Missing or unused import statement only — under 5 lines. Auto-approved.',
    test: ({ diff, lineCount }: RuleInput): boolean => {
      if (lineCount > 5) return false;
      return isImportOnlyDiff(diff);
    },
  },

  // ── Rule 3: Typo fixes in strings / comments ───────────────────────────────
  {
    name: 'typo_fix',
    description:
      'Typo correction in string literals or comments only — under 3 lines. Auto-approved.',
    test: ({ diff, lineCount }: RuleInput): boolean => {
      if (lineCount > 3) return false;
      return isStringOrCommentOnlyDiff(diff);
    },
  },

  // ── Default: manual admin approval required ────────────────────────────────
  // (No catch-all rule — if nothing matches, autoApprove stays false)
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a proposed fix against all auto-approval rules.
 *
 * Runs each rule in order and returns on the first match. If no rule matches,
 * returns `{ autoApprove: false }` — the fix requires manual admin review.
 *
 * @param issue - The scan issue the fix addresses.
 * @param diff - The unified diff proposed by Claude.
 * @param lineCount - Pre-computed changed line count (avoids re-counting).
 * @param classification - Claude's fix classification ('bug-fix' | 'config-fix').
 * @returns Whether the fix can be auto-approved and which rule matched.
 */
export function evaluateAutoApproval(
  issue: RuleIssue,
  diff: string,
  lineCount: number,
  classification: string
): AutoApprovalResult {
  if (!diff || !diff.trim()) {
    return { autoApprove: false };
  }

  const input: RuleInput = { issue, diff, lineCount, classification };

  for (const rule of AUTO_APPROVAL_RULES) {
    if (rule.test(input)) {
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
 * Log an auto-approval event to the service_manager_activity table.
 * Non-fatal — failures are logged to console but do not throw.
 *
 * @param fixId - UUID of the fix that was auto-approved.
 * @param scanId - UUID of the scan that produced the issue.
 * @param ruleName - Name of the rule that matched.
 * @param ruleDescription - Human-readable description of the matched rule.
 * @param extraDetails - Any additional context to include in the log entry.
 */
export async function logAutoApproval(
  fixId: string,
  scanId: string,
  ruleName: string,
  ruleDescription: string,
  extraDetails: Record<string, unknown> = {}
): Promise<void> {
  try {
    await createAdminClient()
      .from('service_manager_activity')
      .insert({
        action: 'auto_approved',
        details: {
          fix_id: fixId,
          scan_id: scanId,
          rule_name: ruleName,
          rule_description: ruleDescription,
          ...extraDetails,
        },
        created_by: null, // System action — no user session
      });
  } catch (err) {
    logger.error('[service-manager-rules] logAutoApproval error:', err);
  }
}
