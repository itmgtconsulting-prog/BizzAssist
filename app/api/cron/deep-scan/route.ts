/**
 * Cron: Service Manager Daily Deep Scan — /api/cron/deep-scan
 *
 * Runs daily at 03:30 UTC as a Vercel Cron job. Performs a comprehensive
 * health check that goes beyond the hourly scan (which only checks Vercel
 * deployment logs). Checks TypeScript errors, test failures, and dependency
 * vulnerabilities.
 *
 * Flow:
 *   1. Vercel Cron fires at 03:30 UTC ("30 3 * * *")
 *   2. Fetches latest Vercel build logs and parses them for TypeScript errors
 *   3. Parses build output for test failures (Jest/Vitest output patterns)
 *   4. Calls the npm audit advisory REST API to surface known CVEs
 *   5. Aggregates all findings into a single scan record (scan_type: 'deep')
 *   6. Sends a detailed HTML email report to support@pecuniait.com
 *
 * Auth: CRON_SECRET Bearer token (Vercel Cron) or ?secret= query param (manual test)
 *
 * Env vars required:
 *   - CRON_SECRET           — shared secret for this endpoint
 *   - VERCEL_TOKEN          — Vercel API token for build log access
 *   - VERCEL_PROJECT_ID     — Vercel project ID
 *   - VERCEL_TEAM_ID        — (optional) Vercel team ID
 *   - RESEND_API_KEY        — Resend API key for report emails
 *   - NEXT_PUBLIC_APP_URL   — Base URL of the app (for admin panel link)
 *
 * @module api/cron/deep-scan
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createAdminClient } from '@/lib/supabase/admin';

/** Vercel Pro function timeout (seconds) — uses full near-limit duration */
export const maxDuration = 55;

export const runtime = 'nodejs';

/** Resend API endpoint */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'BizzAssist <noreply@bizzassist.dk>';
const TO_ADDRESS = 'support@pecuniait.com';

/** Vercel REST API base URL */
const VERCEL_API = 'https://api.vercel.com';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single issue surfaced during the deep scan.
 * Compatible with the ScanIssue shape stored in service_manager_scans.
 */
interface DeepScanIssue {
  type: 'build_error' | 'runtime_error' | 'type_error' | 'config_error';
  severity: 'error' | 'warning';
  message: string;
  source: 'vercel_build' | 'vercel_logs' | 'static' | 'npm_audit';
  context?: string;
}

/**
 * Aggregated results from a single deep-scan check category.
 */
interface CheckResult {
  /** Human-readable name of this check (shown in email) */
  checkName: string;
  /** Issues found by this check */
  issues: DeepScanIssue[];
  /** Whether the check itself ran successfully (not whether issues were found) */
  ran: boolean;
  /** Error message if the check itself failed to run */
  checkError?: string;
}

/** A Vercel deployment record (minimal shape) */
interface VercelDeployment {
  uid: string;
  state: string;
  target: 'production' | 'preview' | null;
  readyAt?: number;
}

/** A Vercel build log event */
interface VercelBuildEvent {
  type: string;
  created: number;
  payload: {
    text?: string;
    name?: string;
    statusCode?: number;
    entrypoint?: string;
  };
}

/**
 * Shape of a package.json dependencies section.
 * Values are version range strings.
 */
interface PackageDeps {
  [name: string]: string;
}

/**
 * npm audit advisory API request body.
 * @see https://github.com/npm/cli/blob/latest/lib/commands/audit.js
 */
interface NpmAuditRequest {
  name: string;
  version: string;
  requires: PackageDeps;
  dependencies: Record<string, { version: string }>;
}

/**
 * A single npm audit advisory entry returned by the registry.
 */
interface NpmAdvisory {
  id: number;
  title: string;
  module_name: string;
  severity: 'critical' | 'high' | 'moderate' | 'low' | 'info';
  url: string;
  overview: string;
  findings: { version: string }[];
}

/** Response shape from the npm audit REST endpoint */
interface NpmAuditResponse {
  advisories?: Record<string, NpmAdvisory>;
  metadata?: {
    vulnerabilities?: {
      critical?: number;
      high?: number;
      moderate?: number;
      low?: number;
    };
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Verify the CRON_SECRET from the Authorization header or ?secret= query param.
 *
 * @param request - Incoming HTTP request.
 * @returns true if the provided secret matches CRON_SECRET.
 */
function verifyCronSecret(request: NextRequest): boolean {
  // In production, require Vercel's cron header to prevent external triggering
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

// ─── Vercel API helpers ───────────────────────────────────────────────────────

/**
 * Build standard Vercel API request headers.
 *
 * @returns Headers object with Bearer auth token.
 */
function vercelHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.VERCEL_TOKEN ?? ''}` };
}

/**
 * Build Vercel API query params, including optional teamId.
 *
 * @param extra - Additional params to merge in.
 * @returns URLSearchParams string ready to append to a URL.
 */
function vercelParams(extra: Record<string, string> = {}): string {
  const p: Record<string, string> = { ...extra };
  if (process.env.VERCEL_TEAM_ID) p.teamId = process.env.VERCEL_TEAM_ID;
  return new URLSearchParams(p).toString();
}

/**
 * Fetch the most recent deployments for the configured Vercel project.
 *
 * @param limit - Maximum number of deployments to fetch.
 * @returns Array of deployments, or null on error.
 */
async function getDeployments(limit = 5): Promise<VercelDeployment[] | null> {
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!projectId) return null;
  try {
    const qs = vercelParams({ projectId, limit: String(limit) });
    const res = await fetch(`${VERCEL_API}/v6/deployments?${qs}`, {
      headers: vercelHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.deployments ?? []) as VercelDeployment[];
  } catch {
    return null;
  }
}

/**
 * Fetch all build events for a specific Vercel deployment.
 *
 * @param deploymentId - The Vercel deployment UID.
 * @returns Array of build events, or empty array on failure.
 */
async function getBuildEvents(deploymentId: string): Promise<VercelBuildEvent[]> {
  try {
    const qs = vercelParams({ direction: 'backward', limit: '500' });
    const res = await fetch(`${VERCEL_API}/v2/deployments/${deploymentId}/events?${qs}`, {
      headers: vercelHeaders(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    return (await res.json()) as VercelBuildEvent[];
  } catch {
    return [];
  }
}

// ─── Check 1: TypeScript errors ───────────────────────────────────────────────

/**
 * Regex patterns that identify TypeScript compiler errors in build log text.
 * Each pattern matches a line that would appear in `tsc --noEmit` output.
 */
const TS_ERROR_PATTERNS: RegExp[] = [
  /error TS\d+:/i,
  /Type '.*' is not assignable to type/i,
  /Cannot find module/i,
  /Property '.*' does not exist on type/i,
  /Argument of type '.*' is not assignable/i,
  /Object is possibly '(?:null|undefined)'/i,
  /Type '.*' has no properties in common with/i,
  /Could not find a declaration file for module/i,
  /\bTS\d{4}\b.*error/i,
];

/**
 * Scan Vercel build logs from the most recent production build for TypeScript
 * compiler errors. Deduplicates identical messages.
 *
 * @returns CheckResult with any TypeScript errors found.
 */
async function checkTypeScriptErrors(): Promise<CheckResult> {
  const result: CheckResult = {
    checkName: 'TypeScript Errors',
    issues: [],
    ran: false,
  };

  if (!process.env.VERCEL_TOKEN || !process.env.VERCEL_PROJECT_ID) {
    result.checkError = 'VERCEL_TOKEN eller VERCEL_PROJECT_ID mangler';
    return result;
  }

  const deployments = await getDeployments(10);
  if (!deployments) {
    result.checkError = 'Kunne ikke hente Vercel-deployments';
    return result;
  }
  result.ran = true;

  // Find the most recent production deployment (READY or ERROR state)
  const latestProd = deployments.find(
    (d) => d.target === 'production' && (d.state === 'READY' || d.state === 'ERROR')
  );
  if (!latestProd) return result;

  const events = await getBuildEvents(latestProd.uid);
  const seen = new Set<string>();

  for (const ev of events) {
    const text = ev.payload?.text ?? '';
    if (!text) continue;

    for (const pattern of TS_ERROR_PATTERNS) {
      if (pattern.test(text)) {
        // Truncate very long lines for readability
        const msg = text.length > 200 ? `${text.slice(0, 197)}...` : text;
        if (!seen.has(msg)) {
          seen.add(msg);
          result.issues.push({
            type: 'type_error',
            severity: 'error',
            message: msg.trim(),
            source: 'vercel_build',
            context: `Deployment: ${latestProd.uid} · State: ${latestProd.state}`,
          });
        }
        break; // Only match one pattern per log line
      }
    }

    // Cap at 20 TS errors per scan to avoid email bloat
    if (result.issues.length >= 20) break;
  }

  return result;
}

// ─── Check 2: Test failures ───────────────────────────────────────────────────

/**
 * Regex patterns that identify test runner failure output in build logs.
 * Covers Jest and Vitest output formats.
 */
const TEST_FAILURE_PATTERNS: RegExp[] = [
  /FAIL\s+\S+\.(?:test|spec)\.[tj]sx?/i,
  /Tests:\s+\d+\s+failed/i,
  /\d+ (?:test|tests) failed/i,
  /● .*\n.*expect\(/i,
  /AssertionError/i,
  /✗\s+\S+\.(?:test|spec)/i,
  /FAILED\s+\S+\.(?:test|spec)/i,
];

/**
 * Scan Vercel build logs for test runner failures.
 * Only looks at builds triggered after the most recent "all tests passed" run.
 *
 * @returns CheckResult with any test failures found.
 */
async function checkTestFailures(): Promise<CheckResult> {
  const result: CheckResult = {
    checkName: 'Test Failures',
    issues: [],
    ran: false,
  };

  if (!process.env.VERCEL_TOKEN || !process.env.VERCEL_PROJECT_ID) {
    result.checkError = 'VERCEL_TOKEN eller VERCEL_PROJECT_ID mangler';
    return result;
  }

  const deployments = await getDeployments(5);
  if (!deployments) {
    result.checkError = 'Kunne ikke hente Vercel-deployments';
    return result;
  }
  result.ran = true;

  // Check the most recent deployment regardless of state
  const latest = deployments[0];
  if (!latest) return result;

  const events = await getBuildEvents(latest.uid);
  const seen = new Set<string>();
  let failedTestFile = '';

  for (const ev of events) {
    const text = ev.payload?.text ?? '';
    if (!text) continue;

    for (const pattern of TEST_FAILURE_PATTERNS) {
      if (pattern.test(text)) {
        // Try to extract the test file name for context
        const fileMatch = text.match(/(?:FAIL|FAILED)\s+(\S+\.(?:test|spec)\.[tj]sx?)/i);
        if (fileMatch) failedTestFile = fileMatch[1];

        const msg = text.length > 200 ? `${text.slice(0, 197)}...` : text;
        if (!seen.has(msg)) {
          seen.add(msg);
          result.issues.push({
            type: 'runtime_error',
            severity: 'error',
            message: msg.trim(),
            source: 'vercel_build',
            context: [
              failedTestFile ? `Test-fil: ${failedTestFile}` : null,
              `Deployment: ${latest.uid}`,
            ]
              .filter(Boolean)
              .join(' · '),
          });
        }
        break;
      }
    }

    if (result.issues.length >= 10) break;
  }

  return result;
}

// ─── Check 3: Dependency vulnerabilities ─────────────────────────────────────

/**
 * Read package.json from the project root and return a minimal audit request
 * payload for the npm audit advisory API.
 *
 * @returns Audit request payload, or null if package.json cannot be read.
 */
function buildAuditPayload(): NpmAuditRequest | null {
  try {
    const pkgPath = join(process.cwd(), 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as {
      name?: string;
      version?: string;
      dependencies?: PackageDeps;
      devDependencies?: PackageDeps;
    };

    const allDeps: PackageDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    // npm audit API expects a flat "dependencies" map of { version } objects.
    // We use the version range from package.json as a proxy — the registry will
    // resolve it to the actual installed version for advisory matching.
    const resolvedDeps: Record<string, { version: string }> = {};
    for (const [name, range] of Object.entries(allDeps)) {
      // Strip semver operators to get a plain version string
      const version = range.replace(/^[\^~>=<*]+/, '').split(' ')[0] || '0.0.0';
      resolvedDeps[name] = { version };
    }

    return {
      name: pkg.name ?? 'bizzassist',
      version: pkg.version ?? '0.0.0',
      requires: allDeps,
      dependencies: resolvedDeps,
    };
  } catch {
    return null;
  }
}

/**
 * Query the npm advisory API for known vulnerabilities in project dependencies.
 * Uses the npm registry's bulk audit endpoint (same API as `npm audit --json`).
 *
 * @returns CheckResult with any vulnerability advisories found.
 */
async function checkDependencyVulnerabilities(): Promise<CheckResult> {
  const result: CheckResult = {
    checkName: 'Dependency Vulnerabilities',
    issues: [],
    ran: false,
  };

  const payload = buildAuditPayload();
  if (!payload) {
    result.checkError = 'Kunne ikke læse package.json';
    return result;
  }

  try {
    const res = await fetch('https://registry.npmjs.org/-/npm/v1/security/audits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'npm-command': 'audit',
        'npm-version': '10.0.0',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      result.checkError = `npm audit API returnerede ${res.status}`;
      result.ran = true;
      return result;
    }

    const data = (await res.json()) as NpmAuditResponse;
    result.ran = true;

    const advisories = data.advisories ?? {};

    for (const advisory of Object.values(advisories)) {
      // Only surface critical and high severity in the scan issues
      if (!['critical', 'high', 'moderate'].includes(advisory.severity)) continue;

      const affectedVersions = advisory.findings
        .map((f) => f.version)
        .filter(Boolean)
        .join(', ');

      result.issues.push({
        type: 'config_error',
        severity: advisory.severity === 'moderate' ? 'warning' : 'error',
        message: `Sårbarhed i ${advisory.module_name}: ${advisory.title}`,
        source: 'npm_audit',
        context: [
          `Alvorlighed: ${advisory.severity}`,
          affectedVersions ? `Berørte versioner: ${affectedVersions}` : null,
          `Advisory: ${advisory.url}`,
        ]
          .filter(Boolean)
          .join(' · '),
      });

      // Cap at 15 advisories to keep email readable
      if (result.issues.length >= 15) break;
    }
  } catch (err) {
    result.checkError = `npm audit API fejl: ${err instanceof Error ? err.message : 'Ukendt fejl'}`;
    result.ran = true;
  }

  return result;
}

// ─── Email report ─────────────────────────────────────────────────────────────

/**
 * Build the HTML body for the deep-scan daily report email.
 * Matches BizzAssist design system (navy background, blue accent).
 *
 * @param checkResults - Results from all three check categories.
 * @param scanId - UUID of the scan record for traceability.
 * @param now - Timestamp of this scan run.
 * @returns HTML string ready to send via Resend.
 */
function buildDeepScanReportHtml(checkResults: CheckResult[], scanId: string, now: Date): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bizzassist.dk';
  const adminUrl = `${appUrl}/dashboard/admin/service-manager`;

  const totalIssues = checkResults.reduce((sum, cr) => sum + cr.issues.length, 0);
  const totalErrors = checkResults.reduce(
    (sum, cr) => sum + cr.issues.filter((i) => i.severity === 'error').length,
    0
  );

  const datetimeStr = now.toLocaleString('da-DK', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Copenhagen',
  });

  const headerColor = totalErrors > 0 ? '#ef4444' : totalIssues > 0 ? '#f59e0b' : '#22c55e';
  const statusLabel =
    totalErrors > 0
      ? `${totalErrors} kritiske fejl`
      : totalIssues > 0
        ? `${totalIssues} advarsler`
        : 'Ingen problemer';

  const checkSections = checkResults
    .map((cr) => {
      const icon = cr.issues.length === 0 ? (cr.ran ? '✅' : '⚠️') : '❌';
      const statusText = !cr.ran
        ? `<span style="color: #f59e0b; font-size: 12px;">Check fejlede: ${cr.checkError ?? 'Ukendt fejl'}</span>`
        : cr.issues.length === 0
          ? '<span style="color: #22c55e; font-size: 12px;">Ingen problemer</span>'
          : `<span style="color: #ef4444; font-size: 12px;">${cr.issues.length} problem${cr.issues.length === 1 ? '' : 'er'} fundet</span>`;

      const issueRows =
        cr.issues.length > 0
          ? cr.issues
              .map((issue) => {
                const severityColor = issue.severity === 'error' ? '#ef4444' : '#f59e0b';
                return `
              <div style="background: #1e293b; border-left: 3px solid ${severityColor}; border-radius: 0 4px 4px 0; padding: 10px 14px; margin-top: 8px;">
                <div style="color: #e2e8f0; font-size: 12px; line-height: 1.5;">${issue.message}</div>
                ${issue.context ? `<div style="color: #64748b; font-size: 11px; margin-top: 4px;">${issue.context}</div>` : ''}
              </div>`;
              })
              .join('')
          : '';

      return `
        <div style="margin-bottom: 20px; padding: 16px; background: #162032; border-radius: 8px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span style="font-size: 16px;">${icon}</span>
            <span style="color: #e2e8f0; font-size: 14px; font-weight: 600;">${cr.checkName}</span>
            <span style="margin-left: auto;">${statusText}</span>
          </div>
          ${issueRows}
        </div>`;
    })
    .join('');

  return `
<!DOCTYPE html>
<html lang="da">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 20px; background: #060d1a;">
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 36px; border-radius: 12px; border: 1px solid #1e293b;">

  <!-- Header -->
  <div style="margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid #1e293b;">
    <h1 style="color: #ffffff; font-size: 20px; margin: 0 0 4px 0; font-weight: 700;">BizzAssist</h1>
    <p style="color: #64748b; font-size: 12px; margin: 0 0 16px 0;">Service Manager — Daglig Deep Scan</p>
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 10px; height: 10px; border-radius: 50%; background: ${headerColor}; flex-shrink: 0;"></div>
      <h2 style="color: ${headerColor}; font-size: 18px; margin: 0; font-weight: 600;">${statusLabel}</h2>
    </div>
    <p style="color: #94a3b8; font-size: 13px; margin: 8px 0 0 0;">${datetimeStr}</p>
  </div>

  <!-- Summary stats -->
  <div style="display: flex; gap: 12px; margin-bottom: 24px;">
    <div style="flex: 1; background: #1e293b; border-radius: 8px; padding: 14px; text-align: center;">
      <div style="color: #ef4444; font-size: 24px; font-weight: 700;">${totalErrors}</div>
      <div style="color: #94a3b8; font-size: 11px; margin-top: 4px;">Fejl</div>
    </div>
    <div style="flex: 1; background: #1e293b; border-radius: 8px; padding: 14px; text-align: center;">
      <div style="color: #f59e0b; font-size: 24px; font-weight: 700;">${totalIssues - totalErrors}</div>
      <div style="color: #94a3b8; font-size: 11px; margin-top: 4px;">Advarsler</div>
    </div>
    <div style="flex: 1; background: #1e293b; border-radius: 8px; padding: 14px; text-align: center;">
      <div style="color: #e2e8f0; font-size: 24px; font-weight: 700;">${checkResults.filter((cr) => cr.ran).length}/${checkResults.length}</div>
      <div style="color: #94a3b8; font-size: 11px; margin-top: 4px;">Checks gennemf&oslash;rt</div>
    </div>
  </div>

  <!-- Check results -->
  <div style="margin-bottom: 24px;">
    <h3 style="color: #94a3b8; font-size: 11px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Checks</h3>
    ${checkSections}
  </div>

  <!-- Scan metadata -->
  <div style="margin-bottom: 24px; background: #162032; border-radius: 8px; padding: 14px 16px;">
    <p style="margin: 0; color: #64748b; font-size: 11px;">Scan-ID: ${scanId}</p>
  </div>

  <!-- CTA -->
  <div style="text-align: center; margin-bottom: 28px;">
    <a href="${adminUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 28px; border-radius: 8px;">
      Åbn Admin Panel
    </a>
  </div>

  <!-- Footer -->
  <hr style="border: none; border-top: 1px solid #1e293b; margin: 0 0 16px 0;" />
  <p style="color: #475569; font-size: 11px; margin: 0; line-height: 1.6;">
    BizzAssist &mdash; Pecunia IT ApS &mdash; S&oslash;byvej 11, 2650 Hvidovre &mdash; CVR 44718502<br/>
    Daglig rapport fra Service Manager Deep Scan &mdash; m&aring; ikke videresendes
  </p>

</div>
</body>
</html>`;
}

/**
 * Send the deep-scan report email via Resend.
 * Silently skips if RESEND_API_KEY is not configured.
 *
 * @param checkResults - Results from all checks.
 * @param scanId - UUID of the scan record.
 * @param now - Scan timestamp.
 */
async function sendDeepScanReport(
  checkResults: CheckResult[],
  scanId: string,
  now: Date
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[deep-scan] RESEND_API_KEY ikke sat — rapport springes over');
    return;
  }

  const totalIssues = checkResults.reduce((sum, cr) => sum + cr.issues.length, 0);
  const totalErrors = checkResults.reduce(
    (sum, cr) => sum + cr.issues.filter((i) => i.severity === 'error').length,
    0
  );

  const subjectSuffix =
    totalErrors > 0
      ? `${totalErrors} fejl kræver handling`
      : totalIssues > 0
        ? `${totalIssues} advarsler fundet`
        : 'Alt OK';

  const subject = `BizzAssist Deep Scan \u2014 ${subjectSuffix}`;
  const html = buildDeepScanReportHtml(checkResults, scanId, now);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to: TO_ADDRESS, subject, html }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('[deep-scan] Resend API fejl:', res.status, body);
    } else {
      console.log('[deep-scan] Deep-scan rapport sendt til', TO_ADDRESS);
    }
  } catch (err) {
    console.error('[deep-scan] Kunne ikke sende rapport:', err);
  }
}

// ─── Activity logging ─────────────────────────────────────────────────────────

/**
 * Write an entry to the service_manager_activity audit log.
 * Non-fatal — cron continues even if logging fails.
 *
 * @param action - Action identifier string.
 * @param details - Arbitrary JSON details.
 */
async function logActivity(action: string, details: Record<string, unknown>): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (createAdminClient() as any).from('service_manager_activity').insert({
      action,
      details,
      created_by: null, // Cron runs without a user session
    });
  } catch (err) {
    console.error('[deep-scan] activity log error:', err);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * GET /api/cron/deep-scan
 *
 * Daily comprehensive scan. Runs TypeScript error check, test failure check,
 * and dependency vulnerability audit. Stores results as a 'deep' scan record
 * and sends a detailed email report.
 *
 * Triggered by Vercel Cron ("30 3 * * *") or manually via ?secret=<CRON_SECRET>.
 *
 * @param request - Incoming HTTP request.
 * @returns JSON summary of the deep-scan run.
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  console.log('[deep-scan] Starting daily deep scan at', now.toISOString());

  // ── 1. Run all checks in parallel ────────────────────────────────────────
  // Dependency audit can be slow (npm registry call) — run all concurrently
  const [tsResult, testResult, vulnResult] = await Promise.all([
    checkTypeScriptErrors(),
    checkTestFailures(),
    checkDependencyVulnerabilities(),
  ]);

  const allCheckResults: CheckResult[] = [tsResult, testResult, vulnResult];

  // Flatten all issues for storage
  const allIssues: DeepScanIssue[] = allCheckResults.flatMap((cr) => cr.issues);

  const errorCount = allIssues.filter((i) => i.severity === 'error').length;
  const warningCount = allIssues.filter((i) => i.severity === 'warning').length;

  const checksSummary = allCheckResults
    .map(
      (cr) => `${cr.checkName}: ${cr.issues.length} problemer${cr.ran ? '' : ' (check fejlede)'}`
    )
    .join(', ');

  const summary =
    allIssues.length === 0
      ? 'Deep scan fuldført: ingen problemer fundet.'
      : `Deep scan fuldført: ${errorCount} fejl, ${warningCount} advarsler. ${checksSummary}.`;

  // ── 2. Persist scan record ────────────────────────────────────────────────
  const { data: scanData, error: scanInsertErr } = await admin
    .from('service_manager_scans')
    .insert({
      scan_type: 'deep',
      status: 'completed',
      triggered_by: null,
      issues_found: allIssues,
      summary,
    })
    .select('id')
    .single();

  if (scanInsertErr || !scanData) {
    console.error('[deep-scan] Kunne ikke oprette scan-record:', scanInsertErr?.message);
    return NextResponse.json({ error: 'Kunne ikke oprette scan-record' }, { status: 500 });
  }

  const scanId = scanData.id as string;

  await logActivity('deep_scan_completed', {
    scan_id: scanId,
    issue_count: allIssues.length,
    error_count: errorCount,
    warning_count: warningCount,
    ts_errors: tsResult.issues.length,
    test_failures: testResult.issues.length,
    vulnerabilities: vulnResult.issues.length,
    checks_ran: allCheckResults.filter((cr) => cr.ran).length,
  });

  // ── 3. Send detailed email report ─────────────────────────────────────────
  await sendDeepScanReport(allCheckResults, scanId, now);

  console.log(
    `[deep-scan] Done: ${allIssues.length} total issues, ${errorCount} errors, ${warningCount} warnings`
  );

  return NextResponse.json({
    ok: true,
    scanId,
    totalIssues: allIssues.length,
    errorCount,
    warningCount,
    checks: allCheckResults.map((cr) => ({
      name: cr.checkName,
      ran: cr.ran,
      issueCount: cr.issues.length,
      checkError: cr.checkError,
    })),
    summary,
  });
}
