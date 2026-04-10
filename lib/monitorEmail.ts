/**
 * Microsoft Graph API Email Reader — lib/monitorEmail.ts
 *
 * Reads unread emails from the monitor@pecuniait.com shared mailbox via the
 * Microsoft Graph REST API (OAuth2 client-credentials flow). No npm packages —
 * plain fetch() only.
 *
 * Exported functions:
 *   - getAccessToken()      — returns a cached Bearer token
 *   - fetchUnreadEmails()   — returns unread messages from the shared mailbox
 *   - markEmailAsRead()     — marks a message as processed
 *   - classifyEmail()       — categorises a message into an actionable type
 *
 * Required environment variables:
 *   - MONITOR_EMAIL_TENANT_ID      — Azure AD tenant ID (GUID)
 *   - MONITOR_EMAIL_CLIENT_ID      — Azure AD app registration client ID (GUID)
 *   - MONITOR_EMAIL_CLIENT_SECRET  — Azure AD app registration client secret
 *   - MONITOR_EMAIL_ADDRESS        — shared mailbox address (default: monitor@pecuniait.com)
 *
 * IMPORTANT: This module is SERVER-SIDE ONLY. Never import in Client Components.
 *
 * @module lib/monitorEmail
 *
 * @see app/api/cron/monitor-email/route.ts — consumes this module
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default shared mailbox address if env var is not set */
const DEFAULT_MONITOR_ADDRESS = 'monitor@pecuniait.com';

/** Microsoft Graph base URL */
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** OAuth2 token endpoint template */
const TOKEN_ENDPOINT_TEMPLATE = 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token';

/** Microsoft Graph permission scope for app-only access */
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

/** Fetch timeout for Graph API calls (ms) */
const GRAPH_TIMEOUT_MS = 12_000;

/** Maximum emails to fetch per poll in a single Graph request */
const DEFAULT_MAX_COUNT = 20;

/** Buffer time (ms) before token expiry to trigger a refresh */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A cached OAuth2 access token with its expiry timestamp.
 */
interface CachedToken {
  /** Raw Bearer token string */
  value: string;
  /** Unix epoch ms at which the token expires */
  expiresAt: number;
}

/**
 * Shape of a Microsoft Graph email message (minimal fields we need).
 */
export interface GraphEmail {
  /** Unique message ID (opaque string, stable across reads) */
  id: string;
  /** Email subject line */
  subject: string;
  /** ISO 8601 timestamp when the message was received */
  receivedDateTime: string;
  /** First ~255 chars of the body for quick classification */
  bodyPreview: string;
  /** Full body content object */
  body: {
    /** Content type: "html" | "text" */
    contentType: string;
    /** Raw content string */
    content: string;
  };
  /** Sender address info */
  from: {
    emailAddress: {
      name: string;
      address: string;
    };
  };
}

/**
 * Actionable email category used to decide which auto-fix workflow to trigger.
 *
 *   - `github_ci_failure`    — GitHub Actions workflow run failed
 *   - `vercel_deploy_failure`— Vercel deployment failed or errored
 *   - `security_alert`       — GitHub Dependabot / security advisory alert
 *   - `uptime_alert`         — Uptime monitor triggered (generic)
 *   - `unknown`              — Could not match any actionable pattern; skip
 */
export type EmailCategory =
  | 'github_ci_failure'
  | 'vercel_deploy_failure'
  | 'security_alert'
  | 'uptime_alert'
  | 'unknown';

/**
 * Classified email with the original message attached.
 */
export interface ClassifiedEmail {
  /** The raw Graph API message */
  email: GraphEmail;
  /** Determined category */
  category: EmailCategory;
  /**
   * Extracted structured metadata for the category.
   * Shape varies by category — always check category before using fields.
   */
  metadata: EmailMetadata;
}

/**
 * Structured metadata extracted from a classified email.
 * Fields present depend on the category — always narrow by `category` first.
 */
export interface EmailMetadata {
  /** GitHub repository slug (owner/repo) — present for github_* categories */
  repo?: string;
  /** GitHub Actions workflow name — present for github_ci_failure */
  workflowName?: string;
  /** URL of the failed GitHub Actions run — present for github_ci_failure */
  runUrl?: string;
  /** First ~2000 chars of error body — present for github_ci_failure */
  errorSummary?: string;
  /** Vercel project name — present for vercel_deploy_failure */
  vercelProject?: string;
  /** Vercel deployment URL — present for vercel_deploy_failure */
  deploymentUrl?: string;
  /** Error type keyword extracted from subject — present for vercel_deploy_failure */
  errorType?: string;
  /** Raw subject for unknown/uptime alerts */
  subject?: string;
  /** Sender address */
  senderAddress?: string;
}

// ─── Token cache (module-level singleton) ─────────────────────────────────────

/**
 * Module-level token cache — persists across invocations within a single
 * Vercel function instance lifetime (typically several minutes for warm
 * functions). Avoids a new OAuth round-trip on every cron tick.
 */
let tokenCache: CachedToken | null = null;

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Obtain a valid Microsoft Graph Bearer token using the OAuth2
 * client-credentials flow (app-only, no user sign-in required).
 *
 * The token is cached in module memory and reused until 5 minutes before its
 * expiry (`expires_in` seconds reported by Azure AD minus `TOKEN_EXPIRY_BUFFER_MS`).
 *
 * @returns A Bearer token string ready to use in an Authorization header.
 * @throws If any required env var is missing or the token request fails.
 */
export async function getAccessToken(): Promise<string> {
  // Return cached token if still valid
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  const tenantId = process.env.MONITOR_EMAIL_TENANT_ID;
  const clientId = process.env.MONITOR_EMAIL_CLIENT_ID;
  const clientSecret = process.env.MONITOR_EMAIL_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      '[monitorEmail] Manglende env vars: MONITOR_EMAIL_TENANT_ID, ' +
        'MONITOR_EMAIL_CLIENT_ID eller MONITOR_EMAIL_CLIENT_SECRET er ikke sat.'
    );
  }

  const tokenEndpoint = TOKEN_ENDPOINT_TEMPLATE.replace('{tenant_id}', tenantId);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: GRAPH_SCOPE,
  });

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '(no body)');
    throw new Error(
      `[monitorEmail] OAuth2 token-request mislykkedes: HTTP ${res.status} — ${errText}`
    );
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  if (!json.access_token) {
    throw new Error('[monitorEmail] OAuth2 svar mangler access_token-feltet.');
  }

  // Cache: expire (expires_in seconds from now) minus buffer
  const expiresAt = Date.now() + json.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS;
  tokenCache = { value: json.access_token, expiresAt };

  console.log(
    `[monitorEmail] Nyt access token hentet, udløber om ~${Math.round(json.expires_in / 60)} min`
  );

  return json.access_token;
}

// ─── Graph API helpers ────────────────────────────────────────────────────────

/**
 * Build the shared-mailbox user address from env, falling back to default.
 *
 * @returns The monitor mailbox email address.
 */
function getMonitorAddress(): string {
  return process.env.MONITOR_EMAIL_ADDRESS ?? DEFAULT_MONITOR_ADDRESS;
}

/**
 * Build standard headers for Microsoft Graph API requests.
 *
 * @param token - Bearer access token.
 * @returns Headers object.
 */
function graphHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// ─── Email fetching ───────────────────────────────────────────────────────────

/**
 * Fetch unread emails from the monitor@pecuniait.com shared mailbox.
 *
 * Uses OData `$filter=isRead eq false` and orders by most recent first.
 * Returns at most `maxCount` messages (default: 20).
 *
 * @param maxCount - Maximum number of unread emails to retrieve.
 * @returns Array of Graph email messages, or empty array on error.
 */
export async function fetchUnreadEmails(maxCount = DEFAULT_MAX_COUNT): Promise<GraphEmail[]> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.error('[monitorEmail] fetchUnreadEmails: kunne ikke hente token:', err);
    return [];
  }

  const address = getMonitorAddress();

  // Build OData query parameters
  const params = new URLSearchParams({
    $filter: 'isRead eq false',
    $select: 'id,subject,from,receivedDateTime,body,bodyPreview',
    $top: String(Math.min(maxCount, 50)), // Graph hard cap is 999 but we stay conservative
    $orderby: 'receivedDateTime desc',
  });

  const url = `${GRAPH_BASE}/users/${encodeURIComponent(address)}/messages?${params.toString()}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: graphHeaders(token),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '(no body)');
      console.error(
        `[monitorEmail] Graph messages-endpoint returnerede HTTP ${res.status}: ${errText}`
      );
      return [];
    }

    const data = (await res.json()) as { value?: GraphEmail[] };
    const emails = data.value ?? [];

    console.log(`[monitorEmail] Hentede ${emails.length} ulæste emails fra ${address}`);
    return emails;
  } catch (err) {
    console.error('[monitorEmail] fetchUnreadEmails fejlede:', err);
    return [];
  }
}

// ─── Mark as read ─────────────────────────────────────────────────────────────

/**
 * Mark a single email message as read in the shared mailbox.
 *
 * Called after an email has been successfully processed to prevent it from
 * being picked up again on the next cron run.
 *
 * @param messageId - The Graph message ID (from `GraphEmail.id`).
 * @returns `true` if the PATCH succeeded, `false` on error.
 */
export async function markEmailAsRead(messageId: string): Promise<boolean> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.error('[monitorEmail] markEmailAsRead: kunne ikke hente token:', err);
    return false;
  }

  const address = getMonitorAddress();
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(address)}/messages/${encodeURIComponent(messageId)}`;

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: graphHeaders(token),
      body: JSON.stringify({ isRead: true }),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '(no body)');
      console.error(
        `[monitorEmail] Kunne ikke markere email ${messageId} som læst: HTTP ${res.status} — ${errText}`
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error('[monitorEmail] markEmailAsRead fejlede:', err);
    return false;
  }
}

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Strip HTML tags from a string for plain-text matching.
 * Simple regex approach — sufficient for keyword detection.
 *
 * @param html - Raw HTML string.
 * @returns Plain text without tags.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classify an incoming email into an actionable category.
 *
 * Classification is intentionally conservative — ambiguous emails fall into
 * `unknown` and are skipped rather than triggering unintended workflows.
 *
 * Classification logic (evaluated in priority order):
 *   1. `security_alert` — GitHub Dependabot / security advisory sender or subject
 *   2. `github_ci_failure` — GitHub "failed" run notification
 *   3. `vercel_deploy_failure` — Vercel deployment failure
 *   4. `uptime_alert` — generic uptime/down keyword in subject
 *   5. `unknown` — everything else
 *
 * @param email - A raw GraphEmail from the mailbox.
 * @returns A ClassifiedEmail with category and extracted metadata.
 */
export function classifyEmail(email: GraphEmail): ClassifiedEmail {
  const rawSubject = email.subject ?? '';
  // Strip FW:/Fwd: prefixes for forwarded emails (monitor mailbox receives forwards)
  const subject = rawSubject.replace(/^(?:FW|Fwd)\s*:\s*/i, '').trim();
  const senderAddress = email.from?.emailAddress?.address?.toLowerCase() ?? '';
  const senderDomain = senderAddress.split('@').pop() ?? '';
  const subjectLower = subject.toLowerCase();
  const bodyText = stripHtml(email.body?.content ?? '').slice(0, 3000);

  // ── 1. Security alerts (highest priority — never auto-fix) ────────────────
  // GitHub security advisories come from security@github.com or have specific subjects
  const isSecuritySender =
    senderDomain === 'github.com' &&
    (senderAddress.includes('security') ||
      senderAddress.includes('noreply') ||
      senderAddress.includes('dependabot'));
  const isSecuritySubject = /dependabot|security advisory|vulnerability|cve-\d{4}/i.test(subject);

  if (isSecuritySender && isSecuritySubject) {
    return {
      email,
      category: 'security_alert',
      metadata: {
        subject,
        senderAddress,
        errorSummary: bodyText.slice(0, 2000),
        repo: extractGithubRepo(subject),
      },
    };
  }

  // ── 2. GitHub CI failures ─────────────────────────────────────────────────
  // GitHub sends from noreply@github.com; subject matches "[owner/repo] Run failed: ..."
  // For forwarded emails, the sender may not be github.com — match on subject pattern alone
  const isGithubSender = senderDomain === 'github.com';
  const isGithubCiSubject =
    /\[[\w.-]+\/[\w.-]+\]\s+Run\s+failed\b/i.test(subject) ||
    (subjectLower.includes('run failed') && /\[[\w.-]+\/[\w.-]+\]/.test(subject));

  if (isGithubSender || isGithubCiSubject) {
    const repo = extractGithubRepo(subject);
    const workflowName = extractWorkflowName(subject);
    const runUrl = extractUrl(bodyText, /github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+/);

    return {
      email,
      category: 'github_ci_failure',
      metadata: {
        repo,
        workflowName,
        runUrl,
        errorSummary: bodyText.slice(0, 2000),
        senderAddress,
      },
    };
  }

  // ── 3. Vercel deploy failures ─────────────────────────────────────────────
  // Vercel sends from noreply@vercel.com or vercel.com domain
  const isVercelSender = senderDomain === 'vercel.com';
  const isVercelFailSubject =
    /\b(failed|error|deployment\s+error|build\s+failed)\b/i.test(subject) ||
    (subjectLower.includes('deployment') &&
      (subjectLower.includes('fail') || subjectLower.includes('error')));

  if (isVercelSender && isVercelFailSubject) {
    const vercelProject = extractVercelProject(subject, bodyText);
    const deploymentUrl = extractUrl(bodyText, /https:\/\/[a-zA-Z0-9-]+\.vercel\.app/);
    const errorType = extractVercelErrorType(subject);

    return {
      email,
      category: 'vercel_deploy_failure',
      metadata: {
        vercelProject,
        deploymentUrl,
        errorType,
        errorSummary: bodyText.slice(0, 2000),
        senderAddress,
      },
    };
  }

  // ── 4. Uptime alerts (generic) ────────────────────────────────────────────
  // Matches common uptime monitor patterns from services like UptimeRobot,
  // Better Uptime, Freshping, etc.
  const isUptimeSubject = /\b(down|outage|unreachable|alert|incident|monitor(ing)?)\b/i.test(
    subject
  );
  const isUptimeSender = /uptimerobot|betteruptime|freshping|statuspage|pagerduty|opsgenie/i.test(
    senderDomain
  );

  if (isUptimeSubject || isUptimeSender) {
    return {
      email,
      category: 'uptime_alert',
      metadata: {
        subject,
        senderAddress,
        errorSummary: bodyText.slice(0, 1000),
      },
    };
  }

  // ── 5. Unknown — skip ─────────────────────────────────────────────────────
  return {
    email,
    category: 'unknown',
    metadata: { subject, senderAddress },
  };
}

// ─── Extraction helpers ───────────────────────────────────────────────────────

/**
 * Extract a GitHub repository slug (owner/repo) from an email subject.
 * Looks for the "[owner/repo]" prefix used in GitHub notification subjects.
 *
 * @param subject - Email subject line.
 * @returns Repository slug or undefined if not found.
 */
function extractGithubRepo(subject: string): string | undefined {
  const match = subject.match(/\[([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\]/);
  return match?.[1];
}

/**
 * Extract the GitHub Actions workflow name from an email subject.
 * Subject pattern: "[owner/repo] Run failed: WorkflowName - branch (commit)"
 *
 * @param subject - Email subject line.
 * @returns Workflow name or undefined.
 */
function extractWorkflowName(subject: string): string | undefined {
  // Match "Run failed: WorkflowName - ..."
  const match = subject.match(/run\s+failed:\s+([^-]+?)(?:\s*-\s*|\s*$)/i);
  return match?.[1]?.trim();
}

/**
 * Extract a URL matching a given regex pattern from plain text.
 *
 * @param text - Plain text to search in.
 * @param pattern - Regex to match the URL (must capture the full URL path).
 * @returns Full URL string or undefined.
 */
function extractUrl(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  if (!match) return undefined;
  // Return the matched portion; ensure it starts with https://
  const raw = match[0];
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

/**
 * Extract the Vercel project name from the email subject or body.
 * Vercel subjects often contain the project name as the first word or
 * in the pattern "Deployment for <project> failed".
 *
 * @param subject - Email subject line.
 * @param bodyText - Plain text body.
 * @returns Project name or undefined.
 */
function extractVercelProject(subject: string, bodyText: string): string | undefined {
  // Try subject pattern: "Deployment for <project> failed"
  const subjectMatch = subject.match(/(?:deployment\s+for\s+|project\s+)([a-zA-Z0-9_-]+)/i);
  if (subjectMatch?.[1]) return subjectMatch[1];

  // Try body pattern: "Your deployment of <project>"
  const bodyMatch = bodyText.match(/(?:deployment\s+of\s+|project:\s*)([a-zA-Z0-9_-]+)/i);
  return bodyMatch?.[1];
}

/**
 * Extract the error type keyword from a Vercel deploy failure subject.
 * Looks for keywords like "BUILD_FAILED", "timeout", "out of memory", etc.
 *
 * @param subject - Email subject line.
 * @returns Short error type string or "deploy_failure" as default.
 */
function extractVercelErrorType(subject: string): string {
  if (/build\s+fail/i.test(subject)) return 'build_failure';
  if (/timeout/i.test(subject)) return 'timeout';
  if (/out\s+of\s+memory/i.test(subject)) return 'oom';
  if (/cancel/i.test(subject)) return 'cancelled';
  return 'deploy_failure';
}
