/**
 * Auto-ticketing bridge: drift-detektering → JIRA (dedupliceret) — BIZZ-2240.
 *
 * Service Manager (service-scan) finder nu overdue crons, silent no-ops, stale
 * datakilder (BIZZ-2237) og brudt output (BIZZ-2239). Foer dette blev de kun
 * sendt som alarm-email — ingen ticket, altsaa manuel indgriben noedvendig. Denne
 * bro opretter automatisk en JIRA-ticket pr. error-severity drift-issue.
 *
 * Dedup (undgaa board-spam ved timevis scan): hver issue faar en stabil signatur-
 * label `drift-<hash>`. Findes der allerede en AABEN ticket med den label, springes
 * oprettelse over (issuet er stadig under behandling). Er der ingen aaben, oprettes
 * en ny — saa et genopstaaet problem efter luk giver en frisk ticket.
 *
 * Beslutning (BIZZ-2240 aaben-beslutning): tickets oprettes i JIRA_PROJECT_KEY
 * (= BIZZ), samme projekt som alt andet, saa Service Manager-koeen ser dem via
 * `drift-auto`-labelen.
 */
import { createHash } from 'crypto';
import { logger } from '@/app/lib/logger';

/** Minimal issue-form bridgen har brug for (delmaengde af service-scans ScanIssue). */
export interface DriftIssue {
  type: string;
  severity: 'error' | 'warning';
  message: string;
  source: string;
  context?: string;
  /** Stabil dedup-identifikator (fx jobName/sourceName) sat af drift-checket. */
  dedupKey?: string;
}

/** Fælles label så hele drift-koeen kan filtreres i JIRA. */
export const DRIFT_LABEL = 'drift-auto';

/** JIRA-config fra env (samme sæt som monitor-email). Null hvis ikke sat. */
function jiraConfig(): { base: string; project: string; auth: string } | null {
  const base = process.env.JIRA_BASE_URL;
  const project = process.env.JIRA_PROJECT_KEY;
  const token = process.env.JIRA_API_TOKEN;
  const email = process.env.JIRA_USER_EMAIL;
  if (!base || !project || !token || !email) return null;
  return { base, project, auth: Buffer.from(`${email}:${token}`).toString('base64') };
}

/**
 * Stabil signatur-label for et issue. Baseret paa type + kilde + dedupKey (falder
 * tilbage til message hvis dedupKey mangler) → uændret paa tværs af scans saa
 * samme problem giver samme label.
 *
 * @param issue - drift-issue
 * @returns JIRA-label, fx `drift-a1b2c3d4`
 */
export function driftSignatureLabel(issue: DriftIssue): string {
  const basis = `${issue.type}|${issue.source}|${issue.dedupKey ?? issue.message}`;
  return `drift-${createHash('sha1').update(basis).digest('hex').slice(0, 12)}`;
}

/** Escape JQL-strengværdi (kun " og \ er relevante i quoted strings). */
function jqlEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Findes der en aaben (ikke-Done) JIRA-ticket med denne signatur-label?
 *
 * @returns key på en eksisterende aaben ticket, eller null
 */
async function findOpenTicket(
  cfg: { base: string; project: string; auth: string },
  label: string
): Promise<string | null> {
  const jql = `project = "${jqlEscape(cfg.project)}" AND labels = "${jqlEscape(label)}" AND statusCategory != Done`;
  try {
    const res = await fetch(
      `${cfg.base}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=key`,
      {
        headers: { Authorization: `Basic ${cfg.auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) {
      logger.warn(`[drift-bridge] JQL-søgning fejlede: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { issues?: { key: string }[] };
    return data.issues?.[0]?.key ?? null;
  } catch (err) {
    logger.error('[drift-bridge] findOpenTicket fejlede:', err);
    return null;
  }
}

/** Resultat af at synce ét issue til JIRA. */
export interface DriftTicketResult {
  action: 'created' | 'deduped' | 'skipped' | 'error';
  jiraKey?: string;
  label: string;
}

/**
 * Opret (eller dedup mod) en JIRA-ticket for ét drift-issue.
 *
 * @param issue - error-severity drift-issue
 * @returns handling + evt. JIRA-key
 */
export async function syncDriftTicket(issue: DriftIssue): Promise<DriftTicketResult> {
  const label = driftSignatureLabel(issue);
  const cfg = jiraConfig();
  if (!cfg) {
    logger.warn('[drift-bridge] JIRA env mangler — springer auto-ticket over');
    return { action: 'skipped', label };
  }

  const existing = await findOpenTicket(cfg, label);
  if (existing) return { action: 'deduped', jiraKey: existing, label };

  const summary = `[Drift] ${issue.message}`.slice(0, 250);
  const description = [
    `*Type:* ${issue.type}`,
    `*Kilde:* ${issue.source}`,
    `*Severity:* ${issue.severity}`,
    issue.dedupKey ? `*Enhed:* ${issue.dedupKey}` : null,
    '',
    `*Detaljer:* ${issue.context ?? '(ingen)'}`,
    '',
    '_Auto-oprettet af Service Manager drift-scan (BIZZ-2240). Dedupliceres via ' +
      `label ${label}._`,
  ]
    .filter(Boolean)
    .join('\n');

  const body = {
    fields: {
      project: { key: cfg.project },
      summary,
      description,
      issuetype: { name: 'Task' },
      labels: [DRIFT_LABEL, label, `drift-${issue.source}`],
    },
  };

  try {
    const res = await fetch(`${cfg.base}/rest/api/2/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${cfg.auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error(`[drift-bridge] ticket-oprettelse fejlede: HTTP ${res.status}`);
      return { action: 'error', label };
    }
    const data = (await res.json()) as { key: string };
    logger.log(`[drift-bridge] oprettede ${data.key} for ${label}`);
    return { action: 'created', jiraKey: data.key, label };
  } catch (err) {
    logger.error('[drift-bridge] syncDriftTicket fejlede:', err);
    return { action: 'error', label };
  }
}

/**
 * Sync en liste af drift-issues til JIRA. Kun error-severity fra drift-kilder
 * (cron_heartbeat/data_freshness/post_condition) — Vercel-build/runtime-issues
 * haandteres af det eksisterende fix-flow. Cappet for at undgaa flod.
 *
 * @param issues - alle scan-issues
 * @param cap - max antal tickets pr. koersel (default 5)
 * @returns resultater for de behandlede issues
 */
export async function syncDriftTickets(
  issues: DriftIssue[],
  cap = 5
): Promise<DriftTicketResult[]> {
  const driftSources = new Set(['cron_heartbeat', 'data_freshness', 'post_condition']);
  const candidates = issues.filter((i) => i.severity === 'error' && driftSources.has(i.source));
  const results: DriftTicketResult[] = [];
  let created = 0;
  for (const issue of candidates) {
    if (created >= cap) break;
    const r = await syncDriftTicket(issue);
    results.push(r);
    if (r.action === 'created') created++;
  }
  return results;
}
