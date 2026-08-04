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
import { DATA_SOURCES, type DataSource } from '@/app/lib/cron/registry';

/**
 * Status levels for a data domain's freshness.
 * `config_error` = the check itself is misconfigured (table/column doesn't
 * exist). BIZZ-2209: this used to be swallowed as a silent skip in the
 * watchdog, which is exactly how a wrong column name hid 81 days of stale
 * cache. It is now a distinct, loud status the watchdog escalates as critical.
 */
export type FreshnessStatus = 'ok' | 'warning' | 'critical' | 'config_error';

/** Result of a freshness check for a single data domain. */
export interface DomainFreshness {
  /** Stable source key (= DataSource.sourceName / data_sync_status.source_name). */
  sourceName: string;
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

/** Configuration for a single data domain check (derived from the registry). */
type DomainConfig = DataSource;

/**
 * All data domains — derived from the canonical registry (DATA_SOURCES) so the
 * freshness config can no longer drift from the cron/data-source definitions.
 * Thresholds live in app/lib/cron/registry.ts.
 */
const DOMAIN_CONFIGS: DomainConfig[] = DATA_SOURCES;

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
    sourceName: config.sourceName,
    domain: config.label,
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

    // BIZZ-2209: A missing table/column is a CONFIG ERROR, not "no data" — it
    // means the freshness check itself is broken. Surface it loudly so the
    // watchdog escalates it (the wrong-column bug hid 81 days of stale cache).
    const qErr = latestResult.error ?? countResult.error;
    if (qErr) {
      const m = String(qErr.message ?? qErr);
      if (/does not exist|column|relation|schema cache|could not find/i.test(m)) {
        base.status = 'config_error';
        base.error = `Fejl-konfigureret friskhedstjek (${config.table}.${config.timestampColumn}): ${m}`;
        return base;
      }
      base.error = m;
      return base;
    }

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
  const results = await Promise.all(DOMAIN_CONFIGS.map((config) => checkDomain(admin, config)));
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
    if (r.status === 'config_error') {
      Sentry.captureMessage(
        `Data-freshness CONFIG-FEJL: ${r.domain} (${r.table}) — ${r.error}`,
        'error'
      );
    } else if (r.status === 'critical') {
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
  configError: number;
  problems: DomainFreshness[];
} {
  return {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    warning: results.filter((r) => r.status === 'warning').length,
    critical: results.filter((r) => r.status === 'critical').length,
    configError: results.filter((r) => r.status === 'config_error').length,
    problems: results.filter((r) => r.status !== 'ok'),
  };
}
