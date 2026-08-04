/**
 * Canonical cron + data-source registry — SINGLE SOURCE OF TRUTH.
 *
 * BIZZ-2209: Before this file, the cron inventory lived in 4+ places that
 * drifted (vercel.json, each route's withCronMonitor config, the admin
 * cron-status page's hardcoded list, and the external watchdog's ALL_CRONS),
 * plus two freshness configs (a correct one in dataFreshness.ts and a broken
 * one inline in the watchdog). This registry is now the one place; everything
 * else derives from it, and `registry.validation.test.ts` fails CI if the
 * registry, vercel.json, the route files, and the live DB columns disagree.
 *
 * @module app/lib/cron/registry
 */

/** Broad grouping used for dashboard filtering + alert routing. */
export type CronCategory =
  | 'monitoring'
  | 'ingest'
  | 'cache'
  | 'backfill'
  | 'maintenance'
  | 'report'
  | 'seo'
  | 'intel';

/** One scheduled Vercel cron. Keyed by `path` against vercel.json. */
export interface CronJob {
  /** Heartbeat key written by withCronMonitor (recordHeartbeat job_name). */
  jobName: string;
  /** vercel.json path, incl. any query string (e.g. sitemap ?phase=cycle). */
  path: string;
  /** Crontab expression — MUST match vercel.json exactly. */
  schedule: string;
  /** Expected cadence in minutes — used by watchdog/dashboard for overdue. */
  intervalMinutes: number;
  category: CronCategory;
  description: string;
  /**
   * When true, a run that processed nothing (itemsProcessed === 0) or whose
   * external dependency failed is reported as `degraded` rather than `success`
   * — so a silently no-op'ing job (e.g. the mid-May cache freeze) is caught.
   */
  expectsWork?: boolean;
  /** sourceName in DATA_SOURCES that this job refreshes (freshness link). */
  dataSource?: string;
  /**
   * For jobs that record heartbeats under rotating sub-names instead of
   * `jobName` (the sitemap cycle), match the freshest heartbeat by this prefix.
   */
  heartbeatPrefix?: string;
}

/** A continuously-synced data domain with a freshness SLO. */
export interface DataSource {
  /** Stable key — also used as data_sync_status.source_name. */
  sourceName: string;
  /** Human-readable label (da-DK). */
  label: string;
  /** Table whose freshness is checked. */
  table: string;
  /** Timestamp column used for freshness (MUST exist — validated in CI). */
  timestampColumn: string;
  /** Age (hours) at which the source is `warning`. */
  warningHours: number;
  /** Age (hours) at which the source is `critical`. */
  criticalHours: number;
  /** jobName that refreshes this source. */
  producedByJob?: string;
}

const DAY = 1440;
const WEEK = 10080;

/**
 * All scheduled crons. MUST be a bijection with vercel.json `crons[].path`.
 * Adding a cron to vercel.json without a registry entry (or vice-versa) fails
 * `registry.validation.test.ts`.
 */
export const CRON_JOBS: CronJob[] = [
  // ── Monitoring / maintenance ──────────────────────────────────────────────
  {
    jobName: 'watchdog',
    path: '/api/cron/watchdog',
    schedule: '*/30 * * * *',
    intervalMinutes: 30,
    category: 'monitoring',
    description:
      'Cron-heartbeat + datakilde-friskhed + tenant-schema-sweep; alarmerer ved problemer',
  },
  {
    jobName: 'monitor-email',
    path: '/api/cron/monitor-email',
    schedule: '*/5 * * * *',
    intervalMinutes: 5,
    category: 'monitoring',
    description: 'Overvågning af e-mail bounce/complaint-rate',
  },
  {
    jobName: 'service-scan',
    path: '/api/cron/service-scan',
    schedule: '0 * * * *',
    intervalMinutes: 60,
    category: 'monitoring',
    description: 'Timevis scan af infrastruktur-services',
  },
  {
    jobName: 'process-job-queue',
    path: '/api/cron/process-job-queue',
    schedule: '*/5 * * * *',
    intervalMinutes: 5,
    category: 'maintenance',
    description:
      'Durable-kø-worker: claimer og kører batches af lange jobs (>300s) inden for tidsbudget',
  },
  {
    jobName: 'purge-cron-history',
    path: '/api/cron/purge-cron-history',
    schedule: '20 2 * * *',
    intervalMinutes: DAY,
    category: 'maintenance',
    description: 'Beskærer cron_run_history ældre end 90 dage',
  },
  {
    jobName: 'purge-ai-files',
    path: '/api/cron/purge-ai-files',
    schedule: '7 * * * *',
    intervalMinutes: 60,
    category: 'maintenance',
    description: 'Sletter udløbne AI-uploads',
  },
  {
    jobName: 'purge-unverified-users',
    path: '/api/cron/purge-unverified-users',
    schedule: '0 5 * * *',
    intervalMinutes: DAY,
    category: 'maintenance',
    description: 'Sletter ikke-verificerede brugere efter frist',
  },
  {
    jobName: 'domain-retention',
    path: '/api/cron/domain-retention',
    schedule: '30 3 * * *',
    intervalMinutes: DAY,
    category: 'maintenance',
    description: 'GDPR-retention for domæne-federerede data',
  },
  {
    jobName: 'domain-anomalies',
    path: '/api/cron/domain-anomalies',
    schedule: '45 4 * * *',
    intervalMinutes: DAY,
    category: 'monitoring',
    description: 'Detekterer anomalier i domæne-federation',
  },

  // ── SEO ───────────────────────────────────────────────────────────────────
  {
    jobName: 'generate-sitemap',
    path: '/api/cron/generate-sitemap?phase=cycle',
    schedule: '*/15 * * * *',
    intervalMinutes: 15,
    category: 'seo',
    description: 'Sitemap-cyklus (companies/properties/vp/render-xml) — logger under sub-navne',
    heartbeatPrefix: 'generate-sitemap',
  },

  // ── Ingest / delta-sync ───────────────────────────────────────────────────
  {
    jobName: 'pull-tinglysning-aendringer',
    path: '/api/cron/pull-tinglysning-aendringer',
    schedule: '15 3 * * *',
    intervalMinutes: DAY,
    category: 'ingest',
    description: 'Tinglysning delta-sync (5-dages rolling window → ejf_ejerskab)',
    dataSource: 'tinglysning',
  },
  {
    jobName: 'pull-cvr-aendringer',
    path: '/api/cron/pull-cvr-aendringer',
    schedule: '30 3 * * *',
    intervalMinutes: DAY,
    category: 'ingest',
    description: 'CVR delta-sync (virksomheder)',
    dataSource: 'cvr_virksomhed',
  },
  {
    jobName: 'pull-cvr-deltager-aendringer',
    path: '/api/cron/pull-cvr-deltager-aendringer',
    schedule: '45 3 * * *',
    intervalMinutes: DAY,
    category: 'ingest',
    description: 'CVR delta-sync (deltagere)',
  },
  {
    jobName: 'pull-bbr-events',
    path: '/api/cron/pull-bbr-events',
    schedule: '0 3 * * *',
    intervalMinutes: DAY,
    category: 'ingest',
    description: 'BBR hændelsesbesked-feed',
  },
  {
    jobName: 'pull-dar-aendringer',
    path: '/api/cron/pull-dar-aendringer',
    schedule: '0 5 * * *',
    intervalMinutes: DAY,
    category: 'ingest',
    description: 'DAR adresse-delta via DAWA-replikering → cache_dar',
    dataSource: 'cache_dar',
  },
  {
    jobName: 'ingest-ejf-bulk',
    path: '/api/cron/ingest-ejf-bulk',
    schedule: '0 4 * * *',
    intervalMinutes: DAY,
    category: 'ingest',
    description: 'EJF-bulk-ingestion (person→ejendom)',
  },
  {
    jobName: 'sync-tinglysning-detail',
    path: '/api/cron/sync-tinglysning-detail',
    schedule: '45 3 * * *',
    intervalMinutes: DAY,
    category: 'ingest',
    description: 'Tinglysning detalje-sync',
  },
  {
    jobName: 'sync-ejf-all',
    path: '/api/cron/sync-ejf-all',
    schedule: '0 5 * * *',
    intervalMinutes: DAY,
    category: 'ingest',
    description: 'EJF fuld-sync (handelsoplysninger/ejerskifte/administrator)',
    dataSource: 'ejf_ejerskab',
  },

  // ── Cache-refresh / warm ──────────────────────────────────────────────────
  {
    jobName: 'warm-cache',
    path: '/api/cron/warm-cache',
    schedule: '0 4 * * *',
    intervalMinutes: DAY,
    category: 'cache',
    description: 'Priming af top-virksomheders cache',
  },
  {
    jobName: 'warm-bbr-cache',
    path: '/api/cron/warm-bbr-cache',
    schedule: '30 4 * * *',
    intervalMinutes: DAY,
    category: 'cache',
    description: 'Warmer cache_bbr for BFE-er med manglende/stale data',
    expectsWork: true,
    dataSource: 'cache_bbr',
  },
  {
    jobName: 'refresh-cvr-cache',
    path: '/api/cron/refresh-cvr-cache',
    schedule: '15 4 * * *',
    intervalMinutes: DAY,
    category: 'cache',
    description: 'Opdaterer cache_cvr',
    dataSource: 'cache_cvr',
  },
  {
    jobName: 'refresh-cvr-ejerskab',
    path: '/api/cron/refresh-cvr-ejerskab',
    schedule: '0 4 * * *',
    intervalMinutes: DAY,
    category: 'cache',
    description: 'Genopfrisker CVR-ejerskabsrelationer',
  },
  {
    jobName: 'refresh-deltager-berigelse',
    path: '/api/cron/refresh-deltager-berigelse',
    schedule: '15 4 * * *',
    intervalMinutes: DAY,
    category: 'cache',
    description: 'Beriger cvr_deltager',
    dataSource: 'cvr_deltager_berigelse',
  },
  {
    jobName: 'refresh-tinglysning-cache',
    path: '/api/cron/refresh-tinglysning-cache',
    schedule: '30 4 * * *',
    intervalMinutes: DAY,
    category: 'cache',
    description: 'Genopfrisker tinglysning-cache',
  },
  {
    jobName: 'refresh-regnskab-cache',
    path: '/api/cron/refresh-regnskab-cache',
    schedule: '0 6 * * *',
    intervalMinutes: DAY,
    category: 'cache',
    description: 'Genopfrisker regnskabs-cache',
  },
  {
    jobName: 'refresh-vur-cache',
    path: '/api/cron/refresh-vur-cache',
    schedule: '0 3 * * 0',
    intervalMinutes: WEEK,
    category: 'cache',
    description: 'Ugentlig VUR-vurderings-refresh → cache_vur',
    dataSource: 'cache_vur',
  },
  {
    jobName: 'refresh-matrikel-cache',
    path: '/api/cron/refresh-matrikel-cache',
    schedule: '0 5 * * 0',
    intervalMinutes: WEEK,
    category: 'cache',
    description: 'Ugentlig matrikel-cache-refresh',
  },
  {
    jobName: 'refresh-ejendom-status',
    path: '/api/cron/refresh-ejendom-status',
    schedule: '0 2 * * 0',
    intervalMinutes: WEEK,
    category: 'cache',
    description: 'Ugentlig BBR-ejendomsstatus-refresh',
    dataSource: 'bbr_ejendomsstatus',
  },
  {
    jobName: 'refresh-materialized-views',
    path: '/api/cron/refresh-materialized-views',
    schedule: '0 5 * * *',
    intervalMinutes: DAY,
    category: 'cache',
    description: 'Genopbygger materialized views',
  },

  // ── Backfill / gap-fill ───────────────────────────────────────────────────
  {
    jobName: 'backfill-tinglysning-handler',
    path: '/api/cron/backfill-tinglysning-handler',
    schedule: '0 5 * * *',
    intervalMinutes: DAY,
    category: 'backfill',
    description: 'Backfiller manglende tinglysning-handler',
  },
  {
    jobName: 'backfill-ejerandel',
    path: '/api/cron/backfill-ejerandel',
    schedule: '30 4 * * *',
    intervalMinutes: DAY,
    category: 'backfill',
    description: 'Backfiller ejerandele',
  },
  {
    jobName: 'backfill-ejerskifte-historik',
    path: '/api/cron/backfill-ejerskifte-historik',
    schedule: '30 4 * * *',
    intervalMinutes: DAY,
    category: 'backfill',
    description: 'Backfiller ejerskifte_historik',
  },
  {
    jobName: 'backfill-ejerskifte-handel',
    path: '/api/cron/backfill-ejerskifte-handel',
    schedule: '20 6 * * *',
    intervalMinutes: DAY,
    category: 'backfill',
    description: 'Backfiller ejerskifte-handel (flyttet ud af 03–06-vinduet, BIZZ-2209)',
  },
  {
    jobName: 'gap-fill-cvr',
    path: '/api/cron/gap-fill-cvr',
    schedule: '30 5 * * *',
    intervalMinutes: DAY,
    category: 'backfill',
    description: 'Udfylder CVR-huller',
  },
  {
    jobName: 'gap-fill-cvr-deltager',
    path: '/api/cron/gap-fill-cvr-deltager',
    schedule: '0 6 * * *',
    intervalMinutes: DAY,
    category: 'backfill',
    description: 'Udfylder CVR-deltager-huller',
  },

  // ── Intelligence ──────────────────────────────────────────────────────────
  {
    jobName: 'refresh-data-catalog',
    path: '/api/cron/refresh-data-catalog',
    schedule: '0 3 * * *',
    intervalMinutes: DAY,
    category: 'intel',
    description: 'Genopbygger data-katalog til AI-kontekst',
  },
  {
    jobName: 'refresh-knowledge-cache',
    path: '/api/cron/refresh-knowledge-cache',
    schedule: '30 3 * * *',
    intervalMinutes: DAY,
    category: 'intel',
    description:
      'Enqueuer 12 per-topic knowledge-builds til job-køen (tidligere monolitisk 504-timeout, BIZZ-2208)',
  },
  {
    jobName: 'refresh-intel-scorecards',
    path: '/api/cron/refresh-intel-scorecards',
    schedule: '0 4 * * *',
    intervalMinutes: DAY,
    category: 'intel',
    description: 'Genopfrisker intel-scorecards',
  },

  // ── Follows / reports ─────────────────────────────────────────────────────
  {
    jobName: 'poll-properties',
    path: '/api/cron/poll-properties',
    schedule: '30 6 * * *',
    intervalMinutes: DAY,
    category: 'report',
    description: 'Polling af fulgte ejendomme for ændringer',
  },
  {
    jobName: 'deep-scan',
    path: '/api/cron/deep-scan',
    schedule: '30 3 * * *',
    intervalMinutes: DAY,
    category: 'report',
    description: 'Deep-scan af aktive tenants',
  },
  {
    jobName: 'daily-status',
    path: '/api/cron/daily-status',
    schedule: '0 6 * * *',
    intervalMinutes: DAY,
    category: 'report',
    description: 'Daglig infrastruktur-statusrapport (bruger datakilde-friskhed)',
  },
  {
    jobName: 'daily-report',
    path: '/api/cron/daily-report',
    schedule: '0 7 * * *',
    intervalMinutes: DAY,
    category: 'report',
    description: 'Daglig admin-rapport via email',
  },
];

/**
 * All continuously-synced data sources with freshness SLOs.
 * Consumed by dataFreshness.ts (checkAllDataFreshness) and the watchdog.
 * Thresholds mirror the cron cadence (daily: 36h warn / 72h crit; weekly wider).
 */
export const DATA_SOURCES: DataSource[] = [
  {
    sourceName: 'cvr_virksomhed',
    label: 'CVR Virksomheder',
    table: 'cvr_virksomhed',
    timestampColumn: 'sidst_opdateret',
    warningHours: 36,
    criticalHours: 72,
    producedByJob: 'pull-cvr-aendringer',
  },
  {
    sourceName: 'cvr_deltager_berigelse',
    label: 'CVR Deltager-berigelse',
    table: 'cvr_deltager',
    timestampColumn: 'berigelse_sidst',
    warningHours: 36,
    criticalHours: 72,
    producedByJob: 'refresh-deltager-berigelse',
  },
  {
    sourceName: 'cache_bbr',
    label: 'BBR Cache',
    table: 'cache_bbr',
    timestampColumn: 'synced_at',
    warningHours: 36,
    criticalHours: 72,
    producedByJob: 'warm-bbr-cache',
  },
  {
    sourceName: 'bbr_ejendomsstatus',
    label: 'BBR Ejendomsstatus',
    table: 'bbr_ejendom_status',
    timestampColumn: 'status_last_checked_at',
    warningHours: 10 * 24,
    criticalHours: 21 * 24,
    producedByJob: 'refresh-ejendom-status',
  },
  {
    sourceName: 'tinglysning',
    label: 'Tinglysning (delta-sync)',
    table: 'tinglysning_aendring_cursor',
    timestampColumn: 'updated_at',
    warningHours: 36,
    criticalHours: 72,
    producedByJob: 'pull-tinglysning-aendringer',
  },
  {
    sourceName: 'ejf_ejerskab',
    label: 'EJF Ejerskab',
    table: 'ejf_ejerskab',
    timestampColumn: 'sidst_opdateret',
    warningHours: 36,
    criticalHours: 72,
    producedByJob: 'sync-ejf-all',
  },
  {
    sourceName: 'cache_cvr',
    label: 'CVR Cache',
    table: 'cache_cvr',
    timestampColumn: 'synced_at',
    warningHours: 36,
    criticalHours: 72,
    producedByJob: 'refresh-cvr-cache',
  },
  {
    sourceName: 'cache_dar',
    label: 'DAR Adresser',
    table: 'cache_dar',
    timestampColumn: 'synced_at',
    warningHours: 10 * 24,
    criticalHours: 30 * 24,
    producedByJob: 'pull-dar-aendringer',
  },
  {
    sourceName: 'cache_vur',
    label: 'VUR Vurderinger',
    table: 'cache_vur',
    timestampColumn: 'synced_at',
    warningHours: 14 * 24,
    criticalHours: 30 * 24,
    producedByJob: 'refresh-vur-cache',
  },
];

const CRON_BY_NAME = new Map(CRON_JOBS.map((c) => [c.jobName, c]));
const SOURCE_BY_NAME = new Map(DATA_SOURCES.map((s) => [s.sourceName, s]));

/**
 * Look up a cron job by its heartbeat job_name.
 *
 * @param jobName - The registered job name
 * @returns The CronJob, or undefined if not registered
 */
export function getCronJob(jobName: string): CronJob | undefined {
  return CRON_BY_NAME.get(jobName);
}

/**
 * Look up a data source by its stable sourceName.
 *
 * @param sourceName - The registered source name
 * @returns The DataSource, or undefined if not registered
 */
export function getDataSource(sourceName: string): DataSource | undefined {
  return SOURCE_BY_NAME.get(sourceName);
}
