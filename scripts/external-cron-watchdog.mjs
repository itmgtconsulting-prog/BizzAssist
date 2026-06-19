#!/usr/bin/env node
/**
 * External Cron Watchdog — runs on dev server via crontab.
 *
 * Replaces Vercel's broken cron scheduler by checking PROD heartbeats
 * and triggering ALL overdue crons directly. Also sends alert emails.
 *
 * Usage:
 *   node scripts/external-cron-watchdog.mjs [--trigger] [--dry-run] [--quiet]
 *
 * Crontab (every 15 min):
 *   [star]/15 * * * * /usr/bin/node /root/BizzAssist/scripts/external-cron-watchdog.mjs --trigger >> /tmp/external-watchdog.log 2>&1
 *
 * @module scripts/external-cron-watchdog
 */

import fs from 'fs';
import https from 'https';
import pg from 'pg';

// ── Config ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const TRIGGER = args.trigger === 'true';
const DRY_RUN = args['dry-run'] === 'true';
const QUIET = args.quiet === 'true';

const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
function env(key) {
  const m = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m?.[1]?.trim() || '';
}

const PROD_DB_URL = env('SUPABASE_PROD_DB_URL');
const CRON_SECRET = env('CRON_SECRET');
const RESEND_API_KEY = env('RESEND_API_KEY');
const PROD_HOST = 'bizzassist.dk';

/** Suppress alert emails if one was sent within this window (ms) */
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const ALERT_LOCKFILE = '/tmp/external-watchdog-alert.lock';

/**
 * All scheduled cron paths with their expected intervals.
 * Grouped by priority — critical first, then daily, then weekly.
 */
const ALL_CRONS = [
  // ── High-frequency (must run) ──
  { path: '/api/cron/monitor-email',              interval: 5 },
  { path: '/api/cron/watchdog',                    interval: 30 },
  { path: '/api/cron/service-scan',                interval: 60 },
  { path: '/api/cron/generate-sitemap?phase=cycle', interval: 15 },
  { path: '/api/cron/purge-ai-files',              interval: 60 },
  // ── Daily data sync (03:00-06:00 window) ──
  { path: '/api/cron/pull-cvr-aendringer',         interval: 1440 },
  { path: '/api/cron/pull-cvr-deltager-aendringer', interval: 1440 },
  { path: '/api/cron/pull-tinglysning-aendringer', interval: 1440 },
  { path: '/api/cron/pull-bbr-events',             interval: 1440 },
  { path: '/api/cron/pull-dar-aendringer',         interval: 1440 },
  { path: '/api/cron/ingest-ejf-bulk',             interval: 1440 },
  { path: '/api/cron/sync-tinglysning-detail',     interval: 1440 },
  { path: '/api/cron/sync-ejf-all',                interval: 1440 },
  { path: '/api/cron/refresh-cvr-ejerskab',        interval: 1440 },
  { path: '/api/cron/refresh-cvr-cache',           interval: 1440 },
  { path: '/api/cron/refresh-deltager-berigelse',  interval: 1440 },
  { path: '/api/cron/refresh-tinglysning-cache',   interval: 1440 },
  { path: '/api/cron/refresh-materialized-views',  interval: 1440 },
  { path: '/api/cron/refresh-regnskab-cache',      interval: 1440 },
  { path: '/api/cron/refresh-intel-scorecards',    interval: 1440 },
  // refresh-knowledge-cache: crasher konsistent (>300s timeout), aldrig heartbeat.
  // Skal debugges separat — fjernet for at undgå støj i watchdog-log.
  { path: '/api/cron/refresh-data-catalog',        interval: 1440 },
  { path: '/api/cron/backfill-ejerandel',          interval: 1440 },
  { path: '/api/cron/backfill-ejerskifte-historik', interval: 1440 },
  { path: '/api/cron/backfill-ejerskifte-handel',   interval: 1440 },
  { path: '/api/cron/backfill-tinglysning-handler', interval: 1440 },
  { path: '/api/cron/gap-fill-cvr',                interval: 1440 },
  { path: '/api/cron/gap-fill-cvr-deltager',       interval: 1440 },
  { path: '/api/cron/warm-cache',                  interval: 1440 },
  { path: '/api/cron/warm-bbr-cache',              interval: 1440 },
  { path: '/api/cron/deep-scan',                   interval: 1440 },
  { path: '/api/cron/domain-retention',            interval: 1440 },
  { path: '/api/cron/domain-anomalies',            interval: 1440 },
  { path: '/api/cron/poll-properties',             interval: 1440 },
  { path: '/api/cron/purge-unverified-users',      interval: 1440 },
  { path: '/api/cron/daily-status',                interval: 1440 },
  { path: '/api/cron/daily-report',                interval: 1440 },
  // ── Weekly ──
  { path: '/api/cron/refresh-ejendom-status',      interval: 10080 },
  { path: '/api/cron/refresh-vur-cache',           interval: 10080 },
  { path: '/api/cron/refresh-matrikel-cache',      interval: 10080 },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().slice(0, 19)}] ${msg}`);
}

/**
 * Extract job name from cron path (e.g. '/api/cron/watchdog' → 'watchdog').
 *
 * @param {string} path
 * @returns {string}
 */
function jobNameFromPath(path) {
  return path.replace('/api/cron/', '').split('?')[0];
}

/**
 * Make an HTTPS GET request with timeout.
 *
 * @param {string} hostname
 * @param {string} path
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<{status: number, body: string}>}
 */
function httpsGet(hostname, path, headers = {}, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path, headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

/**
 * Send alert via Resend (with 4h cooldown to avoid spam).
 *
 * @param {string} subject
 * @param {string} html
 */
async function sendAlert(subject, html) {
  if (!RESEND_API_KEY) {
    log('WARN: No RESEND_API_KEY — cannot send alert');
    return;
  }
  if (DRY_RUN) {
    log('DRY-RUN: Would send email: ' + subject);
    return;
  }

  // Cooldown check
  try {
    const stat = fs.statSync(ALERT_LOCKFILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < ALERT_COOLDOWN_MS) {
      log(`Alert suppressed (cooldown: ${Math.round(ageMs / 60000)}min / ${ALERT_COOLDOWN_MS / 60000}min)`);
      return;
    }
  } catch { /* no lockfile = send */ }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      from: 'BizzAssist Watchdog <noreply@bizzassist.dk>',
      to: 'support@pecuniait.com',
      subject,
      html,
    });

    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            log('Alert email sent');
            try { fs.writeFileSync(ALERT_LOCKFILE, new Date().toISOString()); } catch {}
          } else {
            log(`Email error: ${res.statusCode} ${data}`);
          }
          resolve();
        });
      }
    );
    req.on('error', e => {
      log('Email send error: ' + e.message);
      resolve();
    });
    req.setTimeout(10000, () => {
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('External cron watchdog' + (TRIGGER ? ' +trigger' : '') + (DRY_RUN ? ' +dry-run' : ''));

  // 1. Check heartbeats
  const client = new pg.Client({ connectionString: PROD_DB_URL });
  await client.connect();
  const { rows } = await client.query(
    'SELECT job_name, last_run_at, last_status, expected_interval_minutes, last_error FROM cron_heartbeats ORDER BY last_run_at DESC'
  );
  await client.end();

  const nowMs = Date.now();
  const heartbeatMap = new Map(rows.map(r => [r.job_name, r]));

  // 2. Find overdue crons — check ALL_CRONS against heartbeats
  const overduePaths = [];
  const overdueDetails = [];

  for (const cron of ALL_CRONS) {
    const jobName = jobNameFromPath(cron.path);
    const hb = heartbeatMap.get(jobName);

    if (!hb) {
      // No heartbeat entry — job has never run, trigger it
      overduePaths.push(cron.path);
      overdueDetails.push({ job: jobName, reason: 'aldrig kørt (ingen heartbeat)' });
      continue;
    }

    const ageMin = (nowMs - new Date(hb.last_run_at).getTime()) / 60000;
    // Tighter threshold for daily jobs: 26h instead of 48h
    // Daily crons should run every 24h — if 26h passed, Vercel missed the window
    const multiplier = cron.interval >= 1440 ? 1.1 : 2;
    const threshold = cron.interval * multiplier + 10;

    if (ageMin > threshold) {
      overduePaths.push(cron.path);
      overdueDetails.push({
        job: jobName,
        reason: `${Math.round(ageMin)} min siden (grænse: ${threshold} min)`,
      });
    }
  }

  const healthy = ALL_CRONS.length - overduePaths.length;
  log(`Healthy: ${healthy}/${ALL_CRONS.length}, Overdue: ${overduePaths.length}`);

  if (overduePaths.length === 0) {
    if (!QUIET) log('All crons healthy');
    return;
  }

  // 3. Alert (with cooldown)
  if (overdueDetails.length >= 3) {
    const subject = `[WATCHDOG] ${overduePaths.length}/${ALL_CRONS.length} cron-jobs overdue`;
    const listHtml = overdueDetails
      .map(d => `<li><strong>${d.job}</strong>: ${d.reason}</li>`)
      .join('');
    const html = `
<h2>Ekstern Watchdog — ${overduePaths.length} overdue crons</h2>
<p>${new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })} — Server 65.21.2.204</p>
<ul>${listHtml}</ul>
${TRIGGER ? '<p>Auto-trigger aktiv — forsøger at køre overdue crons.</p>' : ''}
<hr><p style="color:#666;font-size:11px;">Ekstern watchdog, crontab hvert 15. min.</p>`;
    await sendAlert(subject, html);
  }

  // 4. Trigger overdue crons
  if (TRIGGER && !DRY_RUN) {
    let ok = 0, fail = 0;

    for (const path of overduePaths) {
      try {
        const { status } = await httpsGet(
          PROD_HOST,
          path,
          { Authorization: `Bearer ${CRON_SECRET}`, 'x-vercel-cron': '1' },
          300000 // 5 min timeout — Vercel Pro maxDuration
        );
        const success = status === 200;
        if (success) ok++; else fail++;
        log(`  ${success ? '✓' : '✗'} ${jobNameFromPath(path)} → ${status}`);
      } catch (e) {
        fail++;
        log(`  ✗ ${jobNameFromPath(path)} → ${e.message}`);
      }
      // 2s between triggers
      await new Promise(r => setTimeout(r, 2000));
    }

    log(`Triggered: ${ok} ok, ${fail} failed`);
  }

  log('Done');
}

main().catch(e => {
  log('FATAL: ' + e.message);
  process.exit(1);
});
