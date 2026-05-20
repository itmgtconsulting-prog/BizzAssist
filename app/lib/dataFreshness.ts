/**
 * Data freshness checker — verifies that continuously synced data domains
 * are actually receiving updates within expected thresholds.
 *
 * Each data domain has a configured threshold (max allowed age). The checker
 * queries MAX(timestamp_column) for each domain and flags domains where the
 * most recent record is older than the threshold.
 *
 * Used by:
 *   - daily-status cron (email report)
 *   - future watchdog cron (BIZZ-1196)
 *
 * GDPR: No PII — only aggregate timestamps and row counts.
 *
 * @module app/lib/dataFreshness
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import * as Sentry from '@sentry/nextjs';

/** Status levels for a data domain's freshness. */
export type FreshnessStatus = 'ok' | 'warning' | 'critical';

/** Result of a freshness check for a single data domain. */
export interface DomainFreshness {
  /** Human-readable domain name (e.g. 'CVR Virksomheder'). */
  domain: string;
  /** Database table checked. */
  table: string;
  /** Column used for freshness detection. */
  timestampColumn: string;
  /** Total row count in the table. */
  rowCount: number | null;
  /** Most recent timestamp value found. */
  lastUpdated: string | null;
  /** Hours since last update. */
  hoursSinceUpdate: number | null;
  /** Configured max age in hours before warning. */
  warningThresholdHours: number;
  /** Configured max age in hours before critical. */
  criticalThresholdHours: number;
  /** Computed status based on thresholds. */
  status: FreshnessStatus;
  /** Error message if the check itself failed. */
  error?: string;
}

/** Configuration for a single data domain check. */
interface DomainConfig {
  domain: string;
  table: string;
  timestampColumn: string;
  /** Hours after which status becomes 'warning'. */
  warningHours: number;
  /** Hours after which status becomes 'critical'. */
  criticalHours: number;
}

/**
 * All data domains with active cron sync and their freshness thresholds.
 *
 * Thresholds are set based on the cron schedule:
 *   - Daily crons: warning at 36h, critical at 72h (allows 1 missed run + margin)
 *   - Weekly crons: warning at 10d, critical at 21d
 *   - Hourly crons: warning at 4h, critical at 12h
 */
const DOMAIN_CONFIGS: DomainConfig[] = [
  // ── CVR domain ──────────────────────────────────────────────────────────────
  {
    domain: 'CVR Virksomheder',
    table: 'cvr_virksomhed',
    timestampColumn: 'sidst_opdateret',
    warningHours: 36,
    criticalHours: 72,
  },
  {
    domain: 'CVR Deltager-berigelse',
    table: 'cvr_deltager',
    timestampColumn: 'berigelse_sidst',
    warningHours: 36,
    criticalHours: 72,
  },
  // ── BBR domain ──────────────────────────────────────────────────────────────
  {
    domain: 'BBR Cache',
    table: 'cache_bbr',
    timestampColumn: 'synced_at',
    warningHours: 36,
    criticalHours: 72,
  },
  {
    domain: 'BBR Ejendomsstatus',
    table: 'bbr_ejendom_status',
    timestampColumn: 'status_last_checked_at',
    warningHours: 10 * 24, // Weekly cron — 10 days warning
    criticalHours: 21 * 24, // 21 days critical
  },
  // ── Tinglysning + EJF ───────────────────────────────────────────────────────
  {
    domain: 'Tinglysning (delta-sync)',
    table: 'tinglysning_aendring_cursor',
    timestampColumn: 'updated_at',
    warningHours: 36,
    criticalHours: 72,
  },
  {
    domain: 'EJF Ejerskab',
    table: 'ejf_ejerskab',
    timestampColumn: 'sidst_opdateret',
    warningHours: 36,
    criticalHours: 72,
  },
  // ── Cache tables ────────────────────────────────────────────────────────────
  {
    domain: 'CVR Cache',
    table: 'cache_cvr',
    timestampColumn: 'synced_at',
    warningHours: 36,
    criticalHours: 72,
  },
  {
    domain: 'DAR Adresser',
    table: 'cache_dar',
    timestampColumn: 'synced_at',
    warningHours: 10 * 24, // Less frequently updated
    criticalHours: 30 * 24,
  },
  {
    domain: 'VUR Vurderinger',
    table: 'cache_vur',
    timestampColumn: 'synced_at',
    warningHours: 14 * 24, // Weekly cron planned
    criticalHours: 30 * 24,
  },
];

/**
 * Checks a single data domain for freshness.
 *
 * @param admin  - Supabase admin client (service_role)
 * @param config - Domain configuration
 * @returns Freshness result for the domain
 */
async function checkDomain(
  admin: ReturnType<typeof createAdminClient>,
  config: DomainConfig
): Promise<DomainFreshness> {
  const base: DomainFreshness = {
    domain: config.domain,
    table: config.table,
    timestampColumn: config.timestampColumn,
    rowCount: null,
    lastUpdated: null,
    hoursSinceUpdate: null,
    warningThresholdHours: config.warningHours,
    criticalThresholdHours: config.criticalHours,
    status: 'critical',
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = admin as any;

    // Run count and max-timestamp queries concurrently
    const [countResult, latestResult] = await Promise.all([
      a.from(config.table).select('*', { count: 'exact', head: true }),
      a
        .from(config.table)
        .select(config.timestampColumn)
        .not(config.timestampColumn, 'is', null)
        .order(config.timestampColumn, { ascending: false })
        .limit(1),
    ]);

    base.rowCount = countResult.count ?? null;

    const latestRow = latestResult.data?.[0];
    if (!latestRow || !latestRow[config.timestampColumn]) {
      base.status = 'critical';
      base.error = 'Ingen data fundet';
      return base;
    }

    const lastTs = new Date(latestRow[config.timestampColumn]).getTime();
    const now = Date.now();
    const hoursSince = (now - lastTs) / (1000 * 60 * 60);

    base.lastUpdated = latestRow[config.timestampColumn];
    base.hoursSinceUpdate = Math.round(hoursSince * 10) / 10;

    if (hoursSince >= config.criticalHours) {
      base.status = 'critical';
    } else if (hoursSince >= config.warningHours) {
      base.status = 'warning';
    } else {
      base.status = 'ok';
    }

    return base;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[dataFreshness] Check failed for ${config.table}:`, msg);
    base.error = msg;
    return base;
  }
}

/**
 * Runs freshness checks on all configured data domains.
 * Non-fatal: if a single domain check fails, others still run.
 *
 * @returns Array of freshness results, one per domain
 */
export async function checkAllDataFreshness(): Promise<DomainFreshness[]> {
  const admin = createAdminClient();
  const results = await Promise.all(
    DOMAIN_CONFIGS.map((config) => checkDomain(admin, config))
  );
  return results;
}

/**
 * Runs freshness checks and sends Sentry alerts for warning/critical domains.
 * Call this from cron jobs that should trigger alerts.
 *
 * @returns Array of freshness results
 */
export async function checkFreshnessWithAlerts(): Promise<DomainFreshness[]> {
  const results = await checkAllDataFreshness();

  for (const r of results) {
    if (r.status === 'critical') {
      Sentry.captureMessage(
        `Data-freshness CRITICAL: ${r.domain} (${r.table}) — ` +
          (r.error
            ? r.error
            : `sidst opdateret ${r.hoursSinceUpdate}t siden (grænse: ${r.criticalThresholdHours}t)`),
        'error'
      );
    } else if (r.status === 'warning') {
      Sentry.captureMessage(
        `Data-freshness WARNING: ${r.domain} (${r.table}) — ` +
          `sidst opdateret ${r.hoursSinceUpdate}t siden (grænse: ${r.warningThresholdHours}t)`,
        'warning'
      );
    }
  }

  return results;
}

/**
 * Formats freshness results as a summary object for reporting.
 *
 * @param results - Array of freshness check results
 * @returns Summary with counts and problem list
 */
export function summarizeFreshness(results: DomainFreshness[]): {
  total: number;
  ok: number;
  warning: number;
  critical: number;
  problems: DomainFreshness[];
} {
  return {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    warning: results.filter((r) => r.status === 'warning').length,
    critical: results.filter((r) => r.status === 'critical').length,
    problems: results.filter((r) => r.status !== 'ok'),
  };
}
