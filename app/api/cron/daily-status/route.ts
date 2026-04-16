/**
 * POST /api/cron/daily-status
 *
 * Daily status report cron job — runs at 07:00 CET (06:00 UTC) every day.
 * Sends an HTML email to support@pecuniait.com with aggregate operational
 * metrics for the preceding 24-hour window.
 *
 * Metrics reported (no PII — aggregate counts only):
 *   - Active tenant count (total rows in public.tenants)
 *   - New signups in last 24h (auth.users.created_at)
 *   - Total AI chat messages in last 24h (tenant ai_messages tables, or N/A)
 *   - Supabase DB health (simple ping query on public.tenants)
 *   - Sentry recent errors (placeholder — populate when Sentry API key added)
 *
 * Security:
 *   - Requires Authorization: Bearer <CRON_SECRET> header
 *   - In Vercel production also requires x-vercel-cron: 1 header
 *   - Uses admin client (service_role) — no user session required
 *
 * GDPR: No PII is collected or transmitted. All data is aggregate counts.
 * Retention: This route does not store data — it is a read-only reporter.
 *
 * Schedule: 0 6 * * * UTC (07:00 CET / 08:00 CEST), configured in vercel.json.
 *
 * @module api/cron/daily-status
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { checkAllCertificates, type CertExpiryInfo } from '@/app/lib/certExpiry';
import { recordHeartbeat } from '@/app/lib/cronHeartbeat';
import { companyInfo } from '@/app/lib/companyInfo';
import { RESEND_ENDPOINT } from '@/app/lib/serviceEndpoints';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Vercel function max duration (seconds) — stays within Hobby plan limits. */
export const maxDuration = 30;
const FROM_ADDRESS = `BizzAssist Status <${companyInfo.noreplyEmail}>`;
const TO_ADDRESS = companyInfo.supportEmail;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Aggregate metrics for the daily status email. No PII — counts only. */
interface StatusStats {
  /** Total number of tenant rows in public.tenants. */
  tenantCount: number | null;
  /** Number of auth.users with created_at within the last 24 hours. */
  newSignups24h: number | null;
  /** Total ai_messages rows created across all tenant schemas in last 24h. */
  aiChatCalls24h: number | null;
  /** Whether a simple DB ping query succeeded. */
  dbHealthy: boolean;
  /** BIZZ-309: Whether Upstash Redis PING succeeded */
  redisHealthy: boolean;
  /**
   * Sentry recent error count — placeholder until SENTRY_AUTH_TOKEN is
   * added to env and Sentry Issues API is wired up.
   */
  sentryErrors24h: 'N/A';
  /** BIZZ-304: mTLS certificate expiry status */
  certificates: CertExpiryInfo[];
  /** BIZZ-307: AI tokens consumed in last 24h across all tenants */
  aiTokens24h: number | null;
  /** BIZZ-308: Database size in MB */
  dbSizeMb: number | null;
}

/** Minimal shape of a row from public.tenants needed by this route. */
interface TenantRow {
  id: string;
  schema_name: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Verifies the incoming request carries a valid CRON_SECRET bearer token.
 * In Vercel production, also enforces the x-vercel-cron: 1 header to prevent
 * external callers from triggering the job.
 *
 * @param request - Incoming Next.js request
 * @returns true if authorised, false otherwise
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

// ── Data collection ───────────────────────────────────────────────────────────

/**
 * Pings public.tenants with a count query to verify DB connectivity.
 * Returns the count on success; sets dbHealthy=false on any error.
 *
 * @param admin - Supabase admin client (service_role)
 * @returns Tuple of [tenantCount, dbHealthy]
 */
async function pingDb(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ tenantCount: number | null; dbHealthy: boolean }> {
  try {
    const { count, error } = await admin
      .from('tenants')
      .select('id', { count: 'exact', head: true });

    if (error) {
      logger.error('[daily-status] DB health ping failed:', error.message);
      return { tenantCount: null, dbHealthy: false };
    }
    return { tenantCount: count ?? 0, dbHealthy: true };
  } catch (err) {
    logger.error('[daily-status] DB health ping threw:', err);
    return { tenantCount: null, dbHealthy: false };
  }
}

/**
 * Counts auth.users created within the last 24 hours.
 * Uses the Supabase admin.auth.admin.listUsers API (paginates up to 1000 users,
 * sufficient for early growth stage).
 *
 * @param admin - Supabase admin client (service_role)
 * @param since - Start of the 24-hour window
 * @returns New signup count, or null if the query failed
 */
async function countNewSignups(
  admin: ReturnType<typeof createAdminClient>,
  since: Date
): Promise<number | null> {
  try {
    const {
      data: { users },
      error,
    } = await admin.auth.admin.listUsers({ perPage: 1000 });

    if (error) {
      logger.error('[daily-status] Could not fetch auth.users:', error.message);
      return null;
    }
    return users.filter((u) => new Date(u.created_at) > since).length;
  } catch (err) {
    logger.error('[daily-status] countNewSignups threw:', err);
    return null;
  }
}

/** PostgREST error shape returned by tenant schema queries */
interface TenantQueryError {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
}

/**
 * Awaitable query chain for tenant schema tables.
 * Tenant schemas are not in the generated Database types, so we define a
 * structural interface that mirrors PostgrestQueryBuilder without using `any`.
 * All methods return `this` for fluent chaining; awaiting resolves to `data`/`error`.
 */
type TenantQuery = PromiseLike<{
  data: Record<string, unknown>[] | null;
  error: TenantQueryError | null;
  count: number | null;
}> & {
  select(
    cols?: string,
    opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }
  ): TenantQuery;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): TenantQuery;
  update(values: Record<string, unknown>): TenantQuery;
  delete(): TenantQuery;
  eq(col: string, val: unknown): TenantQuery;
  neq(col: string, val: unknown): TenantQuery;
  gte(col: string, val: unknown): TenantQuery;
  lte(col: string, val: unknown): TenantQuery;
  in(col: string, vals: unknown[]): TenantQuery;
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): TenantQuery;
  limit(n: number): TenantQuery;
  range(from: number, to: number): TenantQuery;
  single(): PromiseLike<{ data: Record<string, unknown> | null; error: TenantQueryError | null }>;
};

/**
 * Minimal typed interface for a schema-switched Supabase query builder.
 * The generated types only cover the public schema; tenant schemas require
 * a runtime cast. TenantQuery covers all operations used in this file.
 */
interface SchemaSwitchedClient {
  from: (table: string) => TenantQuery;
}

/**
 * Returns a schema-switched query client for the given tenant schema.
 * Mirrors the helper pattern used in purge-old-data and daily-report.
 *
 * @param admin      - Supabase admin client (service_role)
 * @param schemaName - Tenant schema name, e.g. "tenant_abc123"
 * @returns Schema-switched query client
 */
function tenantSchema(
  admin: ReturnType<typeof createAdminClient>,
  schemaName: string
): SchemaSwitchedClient {
  return (admin as unknown as { schema: (s: string) => SchemaSwitchedClient }).schema(schemaName);
}

/**
 * Counts AI chat messages (ai_messages rows) created across all active tenant
 * schemas in the last 24 hours. Iterates every tenant; errors per tenant are
 * swallowed so a single bad schema does not abort the report.
 *
 * Returns null if the tenant list itself cannot be fetched.
 *
 * @param admin    - Supabase admin client (service_role)
 * @param sinceIso - ISO 8601 timestamp for the start of the window
 * @returns Total ai_messages count across all tenants, or null on hard failure
 */
async function countAiChatCalls(
  admin: ReturnType<typeof createAdminClient>,
  sinceIso: string
): Promise<number | null> {
  let total = 0;

  try {
    const { data: tenants, error } = (await admin.from('tenants').select('id, schema_name')) as {
      data: TenantRow[] | null;
      error: unknown;
    };

    if (error || !tenants) {
      logger.error('[daily-status] Could not fetch tenants for AI count:', error);
      return null;
    }

    for (const tenant of tenants) {
      try {
        // Switch to the tenant's private schema and count ai_messages rows.
        // The Supabase JS client's .schema() is not in generated types for
        // tenant schemas, so we use SchemaSwitchedClient cast above.
        const db = tenantSchema(admin, tenant.schema_name);
        const { count } = await db
          .from('ai_messages')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', sinceIso);
        total += count ?? 0;
      } catch {
        // Swallow per-tenant errors — table may not exist yet or schema may be
        // mid-provision. The report still sends with whatever data is available.
      }
    }
  } catch (err) {
    logger.error('[daily-status] countAiChatCalls outer error:', err);
    return null;
  }

  return total;
}

/**
 * Collects all metrics for the status report.
 * Each sub-query is isolated so a single failure returns null for that field
 * without aborting the rest of the collection.
 *
 * @param since - Start of the 24-hour reporting window
 * @returns Populated StatusStats object
 */
async function collectStats(since: Date): Promise<StatusStats> {
  const admin = createAdminClient();
  const sinceIso = since.toISOString();

  // Run independent queries concurrently to minimise total latency.
  const [{ tenantCount, dbHealthy }, newSignups24h, aiChatCalls24h] = await Promise.all([
    pingDb(admin),
    countNewSignups(admin, since),
    countAiChatCalls(admin, sinceIso),
  ]);

  // BIZZ-304: Check mTLS certificate expiry dates
  const certificates = checkAllCertificates();

  // BIZZ-307: AI token usage (last 24h across all tenants)
  let aiTokens24h: number | null = null;
  try {
    const { data: tenants } = await admin.from('tenants').select('schema_name');
    let totalTokens = 0;
    for (const t of tenants ?? []) {
      const { data: usage } = await tenantDb(t.schema_name)
        .from('ai_token_usage')
        .select('tokens_used')
        .gte('created_at', sinceIso);
      if (usage) {
        for (const row of usage) totalTokens += row.tokens_used ?? 0;
      }
    }
    aiTokens24h = totalTokens;
  } catch {
    /* non-fatal */
  }

  // BIZZ-308: Database size estimate
  let dbSizeMb: number | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sizeResult } = await (admin as any).rpc('pg_database_size', {
      db_name: 'postgres',
    });
    if (typeof sizeResult === 'number') dbSizeMb = Math.round(sizeResult / 1024 / 1024);
  } catch {
    /* pg_database_size may not be available via RPC — non-fatal */
  }

  // BIZZ-309: Redis health check
  let redisHealthy = true;
  try {
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (redisUrl && redisToken) {
      const r = await fetch(`${redisUrl}/ping`, {
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) redisHealthy = false;
      else {
        const d = await r.json();
        if (d?.result !== 'PONG') redisHealthy = false;
      }
    }
  } catch {
    redisHealthy = false;
  }

  return {
    tenantCount,
    newSignups24h,
    aiChatCalls24h,
    dbHealthy,
    redisHealthy,
    sentryErrors24h: 'N/A',
    certificates,
    aiTokens24h,
    dbSizeMb,
  };
}

// ── Email HTML ─────────────────────────────────────────────────────────────────

/**
 * Formats a numeric stat value for display in the email.
 * Returns the number as a string, or "N/A" for null values.
 *
 * @param value - The stat value to format
 * @returns Display string
 */
function fmt(value: number | null | 'N/A'): string {
  if (value === null) return 'N/A';
  if (value === 'N/A') return 'N/A';
  return String(value);
}

/**
 * Returns an inline-CSS colour for a stat value based on simple thresholds.
 * Green for positive activity, amber for zero, red for null (data unavailable).
 *
 * @param value     - The value to colour
 * @param positiveIsGood - When true, non-zero values are green; when false (e.g.
 *                         error counts), non-zero values are amber.
 * @returns CSS colour hex string
 */
function statColor(value: number | null | 'N/A', positiveIsGood = true): string {
  if (value === null || value === 'N/A') return '#ef4444'; // red — data unavailable
  if (value === 0) return '#475569'; // slate — nothing to report
  return positiveIsGood ? '#22c55e' : '#f59e0b'; // green or amber
}

/**
 * Builds the HTML body for the daily status email.
 * Uses inline styles throughout for maximum email client compatibility.
 * Design follows the BizzAssist dark-navy system (#0f172a bg, #2563eb accent).
 *
 * No PII is included — all data is aggregate counts.
 *
 * @param stats      - Collected metrics
 * @param reportDate - Timestamp of report generation (UTC)
 * @returns HTML string ready to send via Resend
 */
function buildEmailHtml(stats: StatusStats, reportDate: Date): string {
  const dateStrDa = reportDate.toLocaleDateString('da-DK', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Copenhagen',
  });
  const timeStrCet = reportDate.toLocaleTimeString('da-DK', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Copenhagen',
  });

  const dbStatusText = stats.dbHealthy ? 'OK' : 'FEJL';
  const dbStatusColor = stats.dbHealthy ? '#22c55e' : '#ef4444';

  return `<!DOCTYPE html>
<html lang="da">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BizzAssist Daglig Status</title>
</head>
<body style="margin: 0; padding: 20px; background: #060d1a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 36px; border-radius: 12px; border: 1px solid #1e293b;">

    <!-- Header -->
    <div style="margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid #1e293b;">
      <h1 style="margin: 0 0 2px 0; color: #ffffff; font-size: 20px; font-weight: 700;">BizzAssist</h1>
      <p style="margin: 0 0 16px 0; color: #64748b; font-size: 11px;">Daglig Driftsstatus &mdash; intern rapport</p>
      <h2 style="margin: 0 0 4px 0; color: #2563eb; font-size: 17px; font-weight: 600;">Daglig Status</h2>
      <p style="margin: 0; color: #94a3b8; font-size: 12px;">
        ${dateStrDa} &mdash; genereret kl. ${timeStrCet} CET
      </p>
    </div>

    <!-- Stats grid -->
    <div style="margin-bottom: 24px;">
      <h3 style="margin: 0 0 12px 0; color: #94a3b8; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600;">Platformsoversigt (seneste 24h)</h3>

      <!-- Tenant count -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">Aktive tenants (total)</span>
        <span style="font-size: 20px; font-weight: 700; color: #2563eb;">${fmt(stats.tenantCount)}</span>
      </div>

      <!-- New signups -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">Nye tilmeldinger (24h)</span>
        <span style="font-size: 20px; font-weight: 700; color: ${statColor(stats.newSignups24h)};">${fmt(stats.newSignups24h)}</span>
      </div>

      <!-- AI chat calls -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">AI chat-beskeder (24h)</span>
        <span style="font-size: 20px; font-weight: 700; color: ${statColor(stats.aiChatCalls24h)};">${fmt(stats.aiChatCalls24h)}</span>
      </div>

      <!-- Sentry errors -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">Sentry fejl (24h)</span>
        <span style="font-size: 20px; font-weight: 700; color: #475569;">${fmt(stats.sentryErrors24h)}</span>
      </div>
    </div>

    <!-- DB health -->
    <div style="margin-bottom: 28px;">
      <h3 style="margin: 0 0 12px 0; color: #94a3b8; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600;">Infrastruktur</h3>
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">Supabase DB (ping)</span>
        <span style="font-size: 13px; font-weight: 700; padding: 3px 10px; border-radius: 4px; background: ${stats.dbHealthy ? '#14532d' : '#450a0a'}; color: ${dbStatusColor};">${dbStatusText}</span>
      </div>
      <!-- BIZZ-309: Redis health -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">Upstash Redis (ping)</span>
        <span style="font-size: 13px; font-weight: 700; padding: 3px 10px; border-radius: 4px; background: ${stats.redisHealthy ? '#14532d' : '#450a0a'}; color: ${stats.redisHealthy ? '#22c55e' : '#ef4444'};">${stats.redisHealthy ? 'OK' : 'FEJL'}</span>
      </div>
      ${
        stats.aiTokens24h !== null
          ? `
      <!-- BIZZ-307: AI token usage -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">AI tokens (24h)</span>
        <span style="font-size: 13px; font-weight: 700; color: ${stats.aiTokens24h > 4000000 ? '#f59e0b' : '#22c55e'};">${stats.aiTokens24h.toLocaleString('da-DK')}</span>
      </div>`
          : ''
      }
      ${
        stats.dbSizeMb !== null
          ? `
      <!-- BIZZ-308: DB size -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">Database st&oslash;rrelse</span>
        <span style="font-size: 13px; font-weight: 700; color: ${stats.dbSizeMb > 7000 ? '#ef4444' : stats.dbSizeMb > 5000 ? '#f59e0b' : '#22c55e'};">${stats.dbSizeMb.toLocaleString('da-DK')} MB</span>
      </div>`
          : ''
      }
    </div>

    <!-- BIZZ-304: Certificate expiry status -->
    ${
      stats.certificates.length > 0
        ? `<div style="margin-bottom: 28px;">
      <h3 style="margin: 0 0 12px 0; color: #94a3b8; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600;">Certifikater (mTLS)</h3>
      ${stats.certificates
        .map((c) => {
          const color =
            c.status === 'ok'
              ? '#22c55e'
              : c.status === 'warning'
                ? '#f59e0b'
                : c.status === 'critical' || c.status === 'expired'
                  ? '#ef4444'
                  : '#475569';
          const label =
            c.daysRemaining !== null ? `${c.daysRemaining} dage` : (c.error ?? 'Ukendt');
          return `<div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">${c.name}</span>
        <span style="font-size: 13px; font-weight: 700; padding: 3px 10px; border-radius: 4px; background: ${color}22; color: ${color};">${label}</span>
      </div>`;
        })
        .join('\n')}
    </div>`
        : ''
    }

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #1e293b; margin: 0 0 16px 0;" />
    <p style="margin: 0; color: #475569; font-size: 10px; line-height: 1.7;">
      BizzAssist &mdash; Pecunia IT ApS &mdash; CVR 44718502<br/>
      Intern driftsrapport &mdash; m&aring; ikke videresendes &mdash; ingen persondata
    </p>

  </div>
</body>
</html>`;
}

// ── Email dispatch ─────────────────────────────────────────────────────────────

/**
 * Sends the status report email via Resend.
 * Logs a warning and returns without throwing if RESEND_API_KEY is absent
 * (allows local development without email credentials).
 *
 * Uses AbortSignal.timeout(10000) to prevent hanging indefinitely on network
 * issues; the cron handler still returns a success response so Vercel does not
 * retry indefinitely.
 *
 * @param html    - Rendered HTML body
 * @param subject - Email subject line
 * @returns true if the email was accepted by Resend, false otherwise
 */
async function sendStatusEmail(html: string, subject: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('[daily-status] RESEND_API_KEY not set — skipping email dispatch');
    return false;
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: TO_ADDRESS,
        subject,
        html,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('[daily-status] Resend API error:', res.status, body);
      return false;
    }

    logger.log('[daily-status] Status report dispatched');
    return true;
  } catch (err) {
    logger.error('[daily-status] Failed to send status email:', err);
    return false;
  }
}

// ── Route handler ──────────────────────────────────────────────────────────────

/**
 * GET /api/cron/daily-status
 *
 * Verifies CRON_SECRET, collects aggregate platform stats for the last 24h,
 * and dispatches a formatted HTML status email to support@pecuniait.com.
 *
 * All stat queries are wrapped in try/catch — if a query fails, the
 * corresponding field is null (displayed as "N/A" in the email) and the
 * email is still sent with all available data.
 *
 * @param request - Incoming Next.js request (must carry CRON_SECRET bearer token)
 * @returns JSON { sent: boolean, stats: StatusStats, reportDate: string }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const stats = await collectStats(since);

  // Subject uses Danish date formatted in CET timezone
  const dateLabel = now.toLocaleDateString('da-DK', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Copenhagen',
  });
  const subject = `BizzAssist Daglig Status \u2014 ${dateLabel}`;

  const html = buildEmailHtml(stats, now);
  const sent = await sendStatusEmail(html, subject);

  // BIZZ-305: Record heartbeat for watchdog monitoring
  recordHeartbeat('daily-status', sent ? 'success' : 'error', Date.now() - now.getTime(), 1440);

  return NextResponse.json({
    sent,
    reportDate: now.toISOString(),
    stats,
  });
}
