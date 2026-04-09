/**
 * Cron: Daglig statusrapport — /api/cron/daily-report
 *
 * Sender en daglig statusrapport til support@pecuniait.com med:
 *   - Antal aktive brugere (last_sign_in_at inden for 24h)
 *   - Antal nye tilmeldinger (created_at inden for 24h)
 *   - Aktive abonnementer fordelt på plan og status
 *   - AI-assistent brug (beskeder + samtaler sendt inden for 24h)
 *   - Ejendomsovervågning (fulgte ejendomme + notifikationer genereret)
 *
 * Sikring:
 *   - Kræver Authorization: Bearer <CRON_SECRET> header — query param ikke accepteret (BIZZ-181)
 *   - Bruger admin client (service_role) — kører uden brugersession
 *
 * Trigger:
 *   - Vercel Cron: dagligt kl. 07:00 UTC (09:00 dansk sommertid)
 *   - Manuel: GET /api/cron/daily-report med Authorization: Bearer <CRON_SECRET>
 *
 * @module api/cron/daily-report
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';

/** Max Vercel Hobby plan funktionsvarighed i sekunder */
export const maxDuration = 30;

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'BizzAssist <noreply@bizzassist.dk>';
const TO_ADDRESS = 'support@pecuniait.com';

/**
 * Verificerer CRON_SECRET fra Authorization-header (Vercel Cron).
 * Query param er ikke accepteret — BIZZ-181.
 *
 * @param request - Indkommende HTTP-request
 * @returns true hvis hemmelighed er gyldig
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

/** Statistik indsamlet for rapportperioden */
interface DailyStats {
  activeUsers: number;
  newSignups: number;
  subscriptionsByPlan: { plan: string; status: string; count: number }[];
  totalActiveSubscriptions: number;
  aiMessages: number;
  aiConversations: number;
  propertiesMonitored: number;
  notificationsGenerated: number;
  agentStats: AgentStats;
}

/** Service Manager og Release Agent aktivitet for perioden */
interface AgentStats {
  // Service Manager
  scansRun: number;
  issuesByType: { build_error: number; runtime_error: number; config_error: number };
  fixSuggestionsGenerated: number;
  fixesApproved: number;
  fixesRejected: number;
  fixesPending: number;
  // Release Agent
  hotfixBranchesCreated: number;
  prsCreated: number;
  deploysTriggered: number;
}

/**
 * Indsamler aktivitetsdata for Service Manager Agent og Release Agent
 * fra de globale (ikke-tenant) tabeller i public-skemaet.
 *
 * @param sinceIso - ISO 8601 tidsstempel for periodens start (24h siden)
 * @returns Aggregerede agent-statistikker
 */
async function collectAgentStats(sinceIso: string): Promise<AgentStats> {
  const admin = createAdminClient();

  const stats: AgentStats = {
    scansRun: 0,
    issuesByType: { build_error: 0, runtime_error: 0, config_error: 0 },
    fixSuggestionsGenerated: 0,
    fixesApproved: 0,
    fixesRejected: 0,
    fixesPending: 0,
    hotfixBranchesCreated: 0,
    prsCreated: 0,
    deploysTriggered: 0,
  };

  // ── Service Manager: scans ────────────────────────────────────────────────
  try {
    const { count: scansCount } = await admin
      .from('service_manager_scans')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sinceIso);
    stats.scansRun = scansCount ?? 0;

    // Issues fordelt på type — hent rows og aggreger client-side
    const { data: scanRows } = await admin
      .from('service_manager_scans')
      .select('issue_type')
      .gte('created_at', sinceIso);

    if (scanRows) {
      for (const row of scanRows) {
        const t = (row as Record<string, unknown>).issue_type as string;
        if (t === 'build_error') stats.issuesByType.build_error++;
        else if (t === 'runtime_error') stats.issuesByType.runtime_error++;
        else if (t === 'config_error') stats.issuesByType.config_error++;
      }
    }
  } catch (err) {
    console.error('[daily-report] Kunne ikke hente service_manager_scans:', err);
  }

  // ── Service Manager: fixes ────────────────────────────────────────────────
  try {
    const { count: fixTotal } = await admin
      .from('service_manager_fixes')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sinceIso);
    stats.fixSuggestionsGenerated = fixTotal ?? 0;

    const { data: fixRows } = await admin
      .from('service_manager_fixes')
      .select('status')
      .gte('created_at', sinceIso);

    if (fixRows) {
      for (const row of fixRows) {
        const s = (row as Record<string, unknown>).status as string;
        if (s === 'approved') stats.fixesApproved++;
        else if (s === 'rejected') stats.fixesRejected++;
        else stats.fixesPending++;
      }
    }
  } catch (err) {
    console.error('[daily-report] Kunne ikke hente service_manager_fixes:', err);
  }

  // ── Release Agent: aktivitet ──────────────────────────────────────────────
  try {
    const { data: actRows } = await admin
      .from('service_manager_activity')
      .select('activity_type')
      .gte('created_at', sinceIso);

    if (actRows) {
      for (const row of actRows) {
        const t = (row as Record<string, unknown>).activity_type as string;
        if (t === 'hotfix_branch_created') stats.hotfixBranchesCreated++;
        else if (t === 'pr_created') stats.prsCreated++;
        else if (t === 'deploy_triggered') stats.deploysTriggered++;
      }
    }
  } catch (err) {
    console.error('[daily-report] Kunne ikke hente service_manager_activity:', err);
  }

  return stats;
}

/**
 * Indsamler alle statistikker fra Supabase for de seneste 24 timer.
 *
 * @param since - Startpunkt for perioden (24h siden)
 * @returns Aggregerede statistikker
 */
async function collectStats(since: Date): Promise<DailyStats> {
  const admin = createAdminClient();
  const sinceIso = since.toISOString();

  // ── Brugere (auth.users) ──────────────────────────────────────────────────
  let activeUsers = 0;
  let newSignups = 0;

  try {
    // Henter op til 1000 brugere — tilstrækkeligt til tidlig vækstfase
    const {
      data: { users },
      error,
    } = await admin.auth.admin.listUsers({ perPage: 1000 });

    if (!error && users) {
      activeUsers = users.filter(
        (u) => u.last_sign_in_at && new Date(u.last_sign_in_at) > since
      ).length;
      newSignups = users.filter((u) => new Date(u.created_at) > since).length;
    }
  } catch (err) {
    console.error('[daily-report] Kunne ikke hente auth.users:', err);
  }

  // ── Abonnementer (public.subscriptions + public.plans) ───────────────────
  const subscriptionsByPlan: { plan: string; status: string; count: number }[] = [];
  let totalActiveSubscriptions = 0;

  try {
    const { data: subs } = (await admin
      .from('subscriptions')
      .select('status, plans(name)')
      .in('status', ['active', 'trialing'])) as {
      data: { status: string; plans: { name: string } | null }[] | null;
    };

    if (subs) {
      totalActiveSubscriptions = subs.length;

      // Grupper pr. plan og status
      const grouped: Record<string, Record<string, number>> = {};
      for (const sub of subs) {
        const planName = sub.plans?.name ?? 'ukendt';
        const st = sub.status;
        if (!grouped[planName]) grouped[planName] = {};
        grouped[planName][st] = (grouped[planName][st] ?? 0) + 1;
      }

      for (const [plan, statuses] of Object.entries(grouped)) {
        for (const [status, count] of Object.entries(statuses)) {
          subscriptionsByPlan.push({ plan, status, count });
        }
      }

      // Sorter pr. plan-navn for konsistent rækkefølge i rapporten
      subscriptionsByPlan.sort((a, b) => a.plan.localeCompare(b.plan, 'da'));
    }
  } catch (err) {
    console.error('[daily-report] Kunne ikke hente abonnementer:', err);
  }

  // ── Agent statistikker (Service Manager + Release Agent) ─────────────────
  const agentStats = await collectAgentStats(sinceIso);

  // ── Per-tenant data (ai_messages, ai_conversations, overvågning) ──────────
  let aiMessages = 0;
  let aiConversations = 0;
  let propertiesMonitored = 0;
  let notificationsGenerated = 0;

  try {
    const { data: tenants } = (await admin.from('tenants').select('id, schema_name')) as {
      data: { id: string; schema_name: string }[] | null;
    };

    if (tenants) {
      for (const tenant of tenants) {
        try {
          const db = tenantDb(tenant.schema_name);

          // AI-beskeder sendt i perioden
          const { count: msgCount } = await db
            .from('ai_messages')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', sinceIso);
          aiMessages += msgCount ?? 0;

          // Nye AI-samtaler startet i perioden
          const { count: convCount } = await db
            .from('ai_conversations')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', sinceIso);
          aiConversations += convCount ?? 0;

          // Antal ejendomme der aktuelt overvåges (total, ikke kun 24h)
          const { count: monCount } = await db
            .from('saved_entities')
            .select('id', { count: 'exact', head: true })
            .eq('entity_type', 'property')
            .eq('is_monitored', true);
          propertiesMonitored += monCount ?? 0;

          // Notifikationer genereret i perioden (fx BBR-ændring, ejerskifte)
          const { count: notifCount } = await db
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', sinceIso);
          notificationsGenerated += notifCount ?? 0;
        } catch {
          // Ignorer fejl pr. tenant — rapporten skal stadig sendes
        }
      }
    }
  } catch (err) {
    console.error('[daily-report] Kunne ikke hente tenant-data:', err);
  }

  return {
    activeUsers,
    newSignups,
    subscriptionsByPlan,
    totalActiveSubscriptions,
    aiMessages,
    aiConversations,
    propertiesMonitored,
    notificationsGenerated,
    agentStats,
  };
}

/**
 * Bygger HTML-indhold til statusrapporten.
 * Stil matcher BizzAssist-designsystemet (navy baggrund, blå accent).
 *
 * Sektioner: Brugere · Abonnementer · AI Assistent · Ejendomsovervågning ·
 * Service Manager Agent · Release Agent
 *
 * @param stats - Indsamlede statistikker inkl. agent-aktivitet
 * @param reportDate - Tidspunkt for rapportgenerering
 * @returns HTML-streng klar til afsendelse
 */
function buildHtml(stats: DailyStats, reportDate: Date): string {
  const dateStrDa = reportDate.toLocaleDateString('da-DK', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStrUtc = reportDate.toLocaleTimeString('da-DK', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });

  // Abonnementsrækker
  const planRows =
    stats.subscriptionsByPlan.length > 0
      ? stats.subscriptionsByPlan
          .map(
            (s) => `
          <tr>
            <td style="padding: 8px 12px; color: #e2e8f0; font-size: 13px; border-bottom: 1px solid #0f172a; text-transform: capitalize;">${s.plan}</td>
            <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid #0f172a; text-transform: capitalize; color: ${s.status === 'active' ? '#22c55e' : '#f59e0b'};">${s.status === 'active' ? 'Aktiv' : 'Prøveperiode'}</td>
            <td style="padding: 8px 12px; text-align: right; font-size: 14px; border-bottom: 1px solid #0f172a; font-weight: 700; color: #2563eb;">${s.count}</td>
          </tr>`
          )
          .join('')
      : `<tr><td colspan="3" style="padding: 10px 12px; color: #64748b; font-size: 13px; font-style: italic;">Ingen aktive abonnementer</td></tr>`;

  return `
<!DOCTYPE html>
<html lang="da">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 20px; background: #060d1a;">
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px; border-radius: 12px; border: 1px solid #1e293b;">

  <!-- Header -->
  <div style="margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #1e293b;">
    <h1 style="color: #ffffff; font-size: 22px; margin: 0 0 4px 0; font-weight: 700;">BizzAssist</h1>
    <p style="color: #64748b; font-size: 12px; margin: 0 0 20px 0;">Danmarks forretningsintelligens platform</p>
    <h2 style="color: #2563eb; font-size: 20px; margin: 0 0 6px 0; font-weight: 600;">Daglig Statusrapport</h2>
    <p style="color: #94a3b8; font-size: 13px; margin: 0;">
      ${dateStrDa} &mdash; genereret kl. ${timeStrUtc} UTC
    </p>
  </div>

  <!-- Brugere -->
  <div style="margin-bottom: 20px;">
    <h3 style="color: #94a3b8; font-size: 11px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Brugere</h3>
    <div style="display: flex; gap: 12px;">
      <div style="flex: 1; background: #1e293b; border-radius: 8px; padding: 20px; text-align: center;">
        <div style="font-size: 36px; font-weight: 700; color: #2563eb; line-height: 1;">${stats.activeUsers}</div>
        <div style="font-size: 12px; color: #94a3b8; margin-top: 6px;">Aktive brugere<br/><span style="color: #64748b;">(seneste 24h)</span></div>
      </div>
      <div style="flex: 1; background: #1e293b; border-radius: 8px; padding: 20px; text-align: center;">
        <div style="font-size: 36px; font-weight: 700; color: ${stats.newSignups > 0 ? '#22c55e' : '#475569'}; line-height: 1;">${stats.newSignups}</div>
        <div style="font-size: 12px; color: #94a3b8; margin-top: 6px;">Nye tilmeldinger<br/><span style="color: #64748b;">(seneste 24h)</span></div>
      </div>
    </div>
  </div>

  <!-- Abonnementer -->
  <div style="margin-bottom: 20px;">
    <h3 style="color: #94a3b8; font-size: 11px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">
      Abonnementer &mdash; <span style="color: #2563eb;">${stats.totalActiveSubscriptions} aktive</span>
    </h3>
    <div style="background: #1e293b; border-radius: 8px; overflow: hidden;">
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #162032;">
            <th style="text-align: left; color: #64748b; font-size: 11px; font-weight: 500; padding: 10px 12px; text-transform: uppercase; letter-spacing: 0.05em;">Plan</th>
            <th style="text-align: left; color: #64748b; font-size: 11px; font-weight: 500; padding: 10px 12px; text-transform: uppercase; letter-spacing: 0.05em;">Status</th>
            <th style="text-align: right; color: #64748b; font-size: 11px; font-weight: 500; padding: 10px 12px; text-transform: uppercase; letter-spacing: 0.05em;">Antal</th>
          </tr>
        </thead>
        <tbody>
          ${planRows}
        </tbody>
      </table>
    </div>
  </div>

  <!-- AI Assistent -->
  <div style="margin-bottom: 20px;">
    <h3 style="color: #94a3b8; font-size: 11px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">AI Bizzness Assistent</h3>
    <div style="background: #1e293b; border-radius: 8px; overflow: hidden;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #0f172a;">Beskeder sendt (24h)</td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; border-bottom: 1px solid #0f172a; color: ${stats.aiMessages > 0 ? '#e2e8f0' : '#475569'};">${stats.aiMessages}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px;">Nye samtaler startet (24h)</td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; color: ${stats.aiConversations > 0 ? '#e2e8f0' : '#475569'};">${stats.aiConversations}</td>
        </tr>
      </table>
    </div>
  </div>

  <!-- Ejendomsovervågning -->
  <div style="margin-bottom: 32px;">
    <h3 style="color: #94a3b8; font-size: 11px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Ejendomsovervågning</h3>
    <div style="background: #1e293b; border-radius: 8px; overflow: hidden;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #0f172a;">Fulgte ejendomme (total)</td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; border-bottom: 1px solid #0f172a;">${stats.propertiesMonitored}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px;">&#9432; Ændringsnotifikationer genereret (24h)</td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; color: ${stats.notificationsGenerated > 0 ? '#f59e0b' : '#475569'};">${stats.notificationsGenerated}</td>
        </tr>
      </table>
    </div>
  </div>

  <!-- Service Manager Agent -->
  <div style="margin-bottom: 20px;">
    <h3 style="color: #94a3b8; font-size: 11px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Service Manager Agent (seneste 24h)</h3>
    <div style="background: #1e293b; border-radius: 8px; overflow: hidden;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #0f172a;">Scans k&oslash;rt</td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; border-bottom: 1px solid #0f172a; color: ${stats.agentStats.scansRun > 0 ? '#e2e8f0' : '#475569'};">${stats.agentStats.scansRun}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #0f172a;">
            Issues fundet
            <span style="color: #64748b; font-size: 11px; margin-left: 8px;">
              build: ${stats.agentStats.issuesByType.build_error} &nbsp;&middot;&nbsp;
              runtime: ${stats.agentStats.issuesByType.runtime_error} &nbsp;&middot;&nbsp;
              config: ${stats.agentStats.issuesByType.config_error}
            </span>
          </td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; border-bottom: 1px solid #0f172a; color: ${stats.agentStats.scansRun > 0 ? '#f59e0b' : '#475569'};">${stats.agentStats.issuesByType.build_error + stats.agentStats.issuesByType.runtime_error + stats.agentStats.issuesByType.config_error}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #0f172a;">Auto-fix forslag genereret</td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; border-bottom: 1px solid #0f172a; color: ${stats.agentStats.fixSuggestionsGenerated > 0 ? '#e2e8f0' : '#475569'};">${stats.agentStats.fixSuggestionsGenerated}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px;">
            Fixes
            <span style="color: #22c55e; font-size: 12px; margin-left: 6px;">&#10003; godkendt: ${stats.agentStats.fixesApproved}</span>
            <span style="color: #ef4444; font-size: 12px; margin-left: 6px;">&#10007; afvist: ${stats.agentStats.fixesRejected}</span>
            <span style="color: #f59e0b; font-size: 12px; margin-left: 6px;">&#8987; ventende: ${stats.agentStats.fixesPending}</span>
          </td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; color: ${stats.agentStats.fixSuggestionsGenerated > 0 ? '#e2e8f0' : '#475569'};">${stats.agentStats.fixesApproved + stats.agentStats.fixesRejected + stats.agentStats.fixesPending}</td>
        </tr>
      </table>
    </div>
  </div>

  <!-- Release Agent -->
  <div style="margin-bottom: 32px;">
    <h3 style="color: #94a3b8; font-size: 11px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Release Agent (seneste 24h)</h3>
    <div style="background: #1e293b; border-radius: 8px; overflow: hidden;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #0f172a;">Hotfix branches oprettet</td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; border-bottom: 1px solid #0f172a; color: ${stats.agentStats.hotfixBranchesCreated > 0 ? '#ef4444' : '#475569'};">${stats.agentStats.hotfixBranchesCreated}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px; border-bottom: 1px solid #0f172a;">PRs oprettet</td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; border-bottom: 1px solid #0f172a; color: ${stats.agentStats.prsCreated > 0 ? '#2563eb' : '#475569'};">${stats.agentStats.prsCreated}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; color: #94a3b8; font-size: 13px;">Deploys triggered</td>
          <td style="padding: 12px 16px; text-align: right; font-size: 15px; font-weight: 700; color: ${stats.agentStats.deploysTriggered > 0 ? '#22c55e' : '#475569'};">${stats.agentStats.deploysTriggered}</td>
        </tr>
      </table>
    </div>
  </div>

  <!-- Footer -->
  <hr style="border: none; border-top: 1px solid #1e293b; margin: 0 0 20px 0;" />
  <p style="color: #475569; font-size: 11px; margin: 0; line-height: 1.6;">
    BizzAssist &mdash; Pecunia IT ApS &mdash; S&oslash;byvej 11, 2650 Hvidovre &mdash; CVR 44718502<br/>
    Intern driftsrapport &mdash; m&aring; ikke videresendes
  </p>

</div>
</body>
</html>`;
}

/**
 * Sender den færdige rapport via Resend.
 * Logger kun og fejler ikke hvis RESEND_API_KEY mangler (dev-miljø).
 *
 * @param html - HTML-indhold til emailen
 * @param subject - Emnelinjen
 */
async function sendReport(html: string, subject: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[daily-report] RESEND_API_KEY ikke sat — emailrapport springes over');
    return;
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
      console.error('[daily-report] Resend API fejl:', res.status, body);
    } else {
      console.log('[daily-report] Statusrapport sendt til', TO_ADDRESS);
    }
  } catch (err) {
    console.error('[daily-report] Kunne ikke sende rapport:', err);
  }
}

/**
 * GET /api/cron/daily-report
 *
 * Indsamler driftsstatistikker for de seneste 24 timer og sender
 * en formateret HTML-statusrapport til support@pecuniait.com via Resend.
 *
 * @param request - Indkommende HTTP-request med CRON_SECRET som Authorization: Bearer header
 * @returns JSON med ok-flag og de indsamlede statistikker
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  // 24 timer tilbage fra nu
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const stats = await collectStats(since);

  // Datostreng til emnelinjen: DD.MM.YYYY
  const dateLabel = now.toLocaleDateString('da-DK', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const subject = `BizzAssist Daglig Status \u2014 ${dateLabel}`;

  const html = buildHtml(stats, now);
  await sendReport(html, subject);

  return NextResponse.json({
    ok: true,
    reportDate: now.toISOString(),
    stats,
  });
}
