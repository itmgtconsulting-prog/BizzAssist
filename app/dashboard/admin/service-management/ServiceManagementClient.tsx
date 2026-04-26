'use client';

/**
 * Infrastructure Service Management — /dashboard/admin/service-management
 *
 * Shows live health status for all BizzAssist infrastructure components.
 * Status is fetched client-side on mount using Promise.allSettled with 5 s timeouts.
 * Static components are marked Operational without a live check.
 *
 * Components:
 *   - Vercel (live)        — https://www.vercel-status.com/api/v2/status.json
 *   - Supabase (live)      — ping via Supabase REST health endpoint
 *   - Upstash Redis        — static Operational
 *   - Anthropic / Claude   — https://status.anthropic.com/api/v2/status.json
 *   - Stripe               — https://status.stripe.com/api/v2/status.json
 *   - Resend               — static Operational
 *   - Datafordeleren       — static Unknown + DAWA deprecation countdown
 *   - CVR ElasticSearch    — static Operational
 *   - Brave Search         — static Operational
 *   - Mapbox               — https://status.mapbox.com/api/v2/status.json
 *
 * Only accessible by admin users (app_metadata.isAdmin === true).
 *
 * @see app/dashboard/admin/users/page.tsx — admin tab nav pattern
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Server,
  Database,
  Zap,
  Activity,
  Clock,
  CreditCard,
  Mail,
  Map,
  Search,
  Globe,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';

/* Search + Server + Activity + AlertTriangle reused by BIZZ-739 KPI row
   + filter above the service grid. */
import { AdminNavTabs } from '../AdminNavTabs';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Status of an infrastructure component */
type ServiceStatus = 'operational' | 'degraded' | 'down' | 'unknown' | 'loading';

/** BIZZ-770: Category split — external 3rd-party APIs vs internal components. */
type ServiceCategory = 'external' | 'internal';

/** A single infrastructure service card definition */
interface ServiceDef {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Category / role description */
  role: string;
  /** Lucide icon component */
  icon: React.ElementType;
  /** External dashboard link */
  link: string;
  /** Whether to fetch live status (true) or use static status */
  live: boolean;
  /** Static status used when live === false */
  staticStatus?: ServiceStatus;
  /** Optional static note shown beneath the status badge */
  note?: string;
  /** URL to fetch Statuspage v2 JSON from (mutually exclusive with pingUrl/probeId) */
  statusUrl?: string;
  /**
   * URL to HTTP-probe via the ping endpoint (mutually exclusive with statusUrl/probeId).
   * Used for services that do not have a Statuspage API (e.g. Datafordeleren).
   */
  pingUrl?: string;
  /**
   * Server-side authenticated probe identifier (mutually exclusive with statusUrl/pingUrl).
   * BIZZ-622: Hits the service with credentials held server-side (never exposed to
   * the browser) to verify the service is actually reachable + authenticating.
   */
  probeId?: string;
  /** BIZZ-770: section grouping. Defaults to 'external' for legacy entries. */
  category?: ServiceCategory;
}

/** Shape of a Atlassian Statuspage v2 /api/v2/status.json response */
interface StatuspageResponse {
  status: {
    indicator: 'none' | 'minor' | 'major' | 'critical';
    description: string;
  };
  page: {
    name: string;
    url: string;
    updated_at: string;
  };
}

/** Runtime status state for a service */
interface ServiceState {
  status: ServiceStatus;
  /** Short human-readable description from the status API */
  description: string | null;
  /** ISO timestamp of the last check */
  checkedAt: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Days remaining until DAWA is shut down (1. juli 2026).
 * Shown as an amber warning banner on the Datafordeleren card.
 */
const daysUntilDawaDeprecation = Math.ceil(
  (new Date('2026-07-01').getTime() - Date.now()) / (1000 * 60 * 60 * 24)
);

/** All infrastructure services shown on the page */
const SERVICES: ServiceDef[] = [
  {
    id: 'vercel',
    name: 'Vercel',
    role: 'Hosting & CI/CD',
    icon: Globe,
    link: 'https://vercel.com/itmgtconsulting-prog/bizzassist',
    live: true,
    statusUrl: 'https://www.vercel-status.com/api/v2/status.json',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    role: 'Database & Auth',
    icon: Database,
    link: 'https://app.supabase.com',
    live: true,
    // Supabase has a public status API on statuspage
    statusUrl: 'https://status.supabase.com/api/v2/status.json',
  },
  {
    id: 'upstash',
    name: 'Upstash Redis',
    role: 'Rate Limiting',
    icon: Zap,
    link: 'https://console.upstash.com',
    // BIZZ-622: Authenticated Redis REST PING via server-side proxy
    live: true,
    probeId: 'upstash',
    note: 'Probed via authenticated Redis REST PING',
  },
  {
    id: 'anthropic',
    name: 'Anthropic / Claude',
    role: 'AI',
    icon: Activity,
    link: 'https://console.anthropic.com',
    live: true,
    statusUrl: 'https://status.anthropic.com/api/v2/status.json',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    role: 'Payments',
    icon: CreditCard,
    link: 'https://dashboard.stripe.com',
    live: true,
    statusUrl: 'https://status.stripe.com/api/v2/status.json',
  },
  {
    id: 'resend',
    name: 'Resend',
    role: 'Email',
    icon: Mail,
    link: 'https://resend.com/emails',
    // BIZZ-622: Authenticated GET /domains via server-side proxy
    live: true,
    probeId: 'resend',
    note: 'Probed via authenticated GET /domains',
  },
  {
    id: 'datafordeler',
    name: 'Datafordeleren',
    role: 'BBR / MAT / DAR / VUR',
    icon: Server,
    link: 'https://datafordeler.dk',
    // BIZZ-377: Used to HEAD-probe api.datafordeler.dk — but that always
    // returned HTTP 401 (Basic Auth required) which the UI rendered as
    // "Ukendt".
    // BIZZ-622: Switched to an authenticated server-side probe that attaches
    // DATAFORDELER_USER/PASS so we can distinguish "reachable + authenticating"
    // from "server down".
    live: true,
    probeId: 'datafordeler',
    note: 'Probed via authenticated BBR schema request',
  },
  {
    id: 'cvr',
    name: 'CVR ElasticSearch',
    role: 'Virksomhedsdata',
    icon: Search,
    link: 'http://distribution.virk.dk',
    // BIZZ-622: Live probe against the Erhvervsstyrelsen ES distribution.
    live: true,
    probeId: 'cvr',
    note: 'Probed via distribution.virk.dk ES search',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    role: 'AI websøgning',
    icon: Search,
    link: 'https://api.search.brave.com',
    // BIZZ-622: Live authenticated probe against Brave Search API.
    live: true,
    probeId: 'brave',
    note: 'Probed via authenticated search query',
  },
  {
    id: 'mapbox',
    name: 'Mapbox',
    role: 'Kort',
    icon: Map,
    link: 'https://account.mapbox.com',
    live: true,
    statusUrl: 'https://status.mapbox.com/api/v2/status.json',
  },
  {
    id: 'mediastack',
    name: 'Mediastack',
    role: 'News feed',
    icon: Globe,
    link: 'https://mediastack.com/dashboard',
    // BIZZ-622: Live authenticated probe against Mediastack news endpoint.
    live: true,
    probeId: 'mediastack',
    note: 'Probed via authenticated news query',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    role: 'SMS',
    icon: Mail,
    link: 'https://console.twilio.com',
    // BIZZ-622: Live probe against the Twilio account resource.
    live: true,
    probeId: 'twilio',
    note: 'Probed via authenticated account lookup',
  },
  // BIZZ-770: Internal components — rendered as a separate section so admins
  // see "External" (3rd-party APIs, above) vs "Internal" (our own moving
  // parts). Most don't have live probes yet — they render Unknown until the
  // underlying metric collection is wired (iter 2).
  {
    id: 'database',
    name: 'Database',
    role: 'PostgreSQL + pgvector query latency',
    icon: Database,
    link: 'https://app.supabase.com',
    live: false,
    staticStatus: 'unknown',
    note: 'Query latency p50/p95 — iter 2',
    category: 'internal',
  },
  {
    id: 'rate-limiter',
    name: 'Rate Limiter',
    role: 'Upstash Redis — blocked requests per route',
    icon: Zap,
    link: 'https://console.upstash.com',
    live: false,
    staticStatus: 'unknown',
    note: 'Blocked-count + eviction rate — iter 2',
    category: 'internal',
  },
  {
    id: 'pgvector',
    name: 'pgvector',
    role: 'Embedding queue + re-index status',
    icon: Activity,
    link: 'https://app.supabase.com',
    live: false,
    staticStatus: 'unknown',
    note: 'Queue depth + last re-index — iter 2',
    category: 'internal',
  },
  {
    id: 'cron-jobs',
    name: 'Cron Jobs',
    role: 'Duration + retry counts (see Cron-status tab for details)',
    icon: Clock,
    link: '/dashboard/admin/cron-status',
    live: false,
    staticStatus: 'unknown',
    note: 'See dedicated Cron-status tab',
    category: 'internal',
  },
  {
    id: 'audit-log',
    name: 'Audit Log',
    role: 'Write-rate + anomaly detection',
    icon: Server,
    link: '/dashboard/admin/security',
    live: false,
    staticStatus: 'unknown',
    note: 'Write-rate alerts — iter 2',
    category: 'internal',
  },
  {
    id: 'email-queue',
    name: 'Email Queue',
    role: 'Resend send queue — pending + failed',
    icon: Mail,
    link: 'https://resend.com/emails',
    live: false,
    staticStatus: 'unknown',
    note: 'Bounce rate + delivery latency — iter 2',
    category: 'internal',
  },
  {
    id: 'ai-tokens',
    name: 'AI Token Burn',
    role: 'Hourly burn rate + quota violations',
    icon: Activity,
    link: 'https://console.anthropic.com',
    live: false,
    staticStatus: 'unknown',
    note: 'Per-tenant quota + model cost — iter 2',
    category: 'internal',
  },
];

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Converts a Statuspage v2 indicator string to our ServiceStatus type.
 *
 * @param indicator - The indicator from the Statuspage v2 API
 * @returns Mapped ServiceStatus value
 */
function indicatorToStatus(indicator: StatuspageResponse['status']['indicator']): ServiceStatus {
  switch (indicator) {
    case 'none':
      return 'operational';
    case 'minor':
      return 'degraded';
    case 'major':
    case 'critical':
      return 'down';
    default:
      return 'unknown';
  }
}

/**
 * Fetches live status from a Statuspage v2 endpoint.
 *
 * @param url - The Statuspage /api/v2/status.json URL
 * @returns Resolved ServiceState or error state on failure
 */
async function fetchStatuspageStatus(url: string): Promise<ServiceState> {
  // BIZZ-347: Route via server-side proxy to avoid CORS blocking
  const proxyUrl = `/api/admin/service-status?url=${encodeURIComponent(url)}`;
  const resp = await fetch(proxyUrl, {
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });
  if (!resp.ok) {
    return {
      status: 'unknown',
      description: 'HTTP fejl ved statushentning',
      checkedAt: new Date().toISOString(),
    };
  }
  const data = (await resp.json()) as StatuspageResponse;
  return {
    status: indicatorToStatus(data.status.indicator),
    description: data.status.description,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Performs an HTTP HEAD probe for services without a Statuspage API
 * (e.g. Datafordeleren) via the server-side ping proxy.
 *
 * Interprets a successful HTTP response (2xx/3xx) as operational, and
 * a failed probe or network error as unknown.
 *
 * BIZZ-377: Used so Datafordeleren shows a live status rather than the
 * static "Ukendt" placeholder it previously had.
 *
 * @param pingUrl - The URL to HEAD-probe (must be in the server-side whitelist)
 * @returns Resolved ServiceState based on the probe result
 */
async function fetchPingStatus(pingUrl: string): Promise<ServiceState> {
  const proxyUrl = `/api/admin/service-status?ping=${encodeURIComponent(pingUrl)}`;
  try {
    const resp = await fetch(proxyUrl, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    if (!resp.ok) {
      return {
        status: 'unknown',
        description: 'HTTP fejl ved statushentning',
        checkedAt: new Date().toISOString(),
      };
    }
    const result = (await resp.json()) as { ok: boolean; httpStatus: number };
    return {
      status: result.ok ? 'operational' : 'unknown',
      description: result.ok
        ? `HTTP ${result.httpStatus}`
        : `HTTP ${result.httpStatus} — kan ikke nås`,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'unknown',
      description: 'Probe fejlede — netværksfejl',
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Runs an authenticated server-side probe for a known service. Credentials
 * stay on the server — the client only sends the service identifier.
 *
 * BIZZ-622: Added for services without a Statuspage API (Datafordeler,
 * Upstash, Resend, CVR ES, Brave, Mediastack, Twilio).
 *
 * @param probeId - Server-side probe identifier
 * @returns Resolved ServiceState based on the probe result
 */
async function fetchProbeStatus(probeId: string): Promise<ServiceState> {
  const proxyUrl = `/api/admin/service-status?probe=${encodeURIComponent(probeId)}`;
  try {
    const resp = await fetch(proxyUrl, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    if (!resp.ok) {
      return {
        status: 'unknown',
        description: 'HTTP fejl ved statushentning',
        checkedAt: new Date().toISOString(),
      };
    }
    const result = (await resp.json()) as {
      ok: boolean;
      httpStatus: number;
      detail?: string;
    };
    let description: string;
    if (result.ok) {
      description = `HTTP ${result.httpStatus}`;
    } else if (result.detail === 'missing_credentials') {
      description = 'Mangler credentials i miljøet';
    } else if (result.httpStatus === 0) {
      description = 'Probe fejlede — netværksfejl';
    } else {
      description = `HTTP ${result.httpStatus} — kan ikke nås`;
    }
    return {
      status: result.ok ? 'operational' : 'unknown',
      description,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'unknown',
      description: 'Probe fejlede — netværksfejl',
      checkedAt: new Date().toISOString(),
    };
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Coloured dot + label badge showing the current service status.
 *
 * @param status - Current status of the service
 * @param da - Whether to use Danish labels
 */
function StatusBadge({ status, da }: { status: ServiceStatus; da: boolean }) {
  const cfg: Record<ServiceStatus, { dot: string; text: string; label: string; labelDa: string }> =
    {
      operational: {
        dot: 'bg-emerald-400',
        text: 'text-emerald-400',
        label: 'Operational',
        labelDa: 'Operationel',
      },
      degraded: {
        dot: 'bg-amber-400',
        text: 'text-amber-400',
        label: 'Degraded',
        labelDa: 'Nedsat',
      },
      down: {
        dot: 'bg-red-400',
        text: 'text-red-400',
        label: 'Down',
        labelDa: 'Nede',
      },
      unknown: {
        dot: 'bg-slate-500',
        text: 'text-slate-400',
        label: 'Unknown',
        labelDa: 'Ukendt',
      },
      loading: {
        dot: 'bg-slate-600 animate-pulse',
        text: 'text-slate-500',
        label: 'Checking…',
        labelDa: 'Tjekker…',
      },
    };
  const c = cfg[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${c.text}`}>
      <span className={`w-2 h-2 rounded-full ${c.dot}`} />
      {da ? c.labelDa : c.label}
    </span>
  );
}

/**
 * A single infrastructure service card.
 *
 * @param service - Static service definition
 * @param state - Live status state for this service
 * @param da - Whether to use Danish labels
 */
function ServiceCard({
  service,
  state,
  da,
}: {
  service: ServiceDef;
  state: ServiceState;
  da: boolean;
}) {
  const Icon = service.icon;
  const isAlert = state.status === 'down' || state.status === 'degraded';
  const showDawaWarning = service.id === 'datafordeler' && daysUntilDawaDeprecation < 90;

  return (
    <article
      className={`bg-[#0f172a] border rounded-xl p-5 flex flex-col gap-3 ${
        isAlert ? 'border-red-500/40' : 'border-slate-700/50'
      }`}
      aria-label={`${service.name} infrastrukturkort`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center shrink-0">
            <Icon size={18} className="text-blue-400" />
          </div>
          <div>
            <h3 className="text-white font-semibold text-sm leading-tight">{service.name}</h3>
            <p className="text-slate-500 text-xs">{service.role}</p>
          </div>
        </div>
        <a
          href={service.link}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Åbn ${service.name} ekstern dashboard`}
          className="text-slate-600 hover:text-slate-300 transition-colors shrink-0 mt-0.5"
        >
          <ExternalLink size={14} />
        </a>
      </div>

      {/* Status */}
      <div>
        <StatusBadge status={state.status} da={da} />
        {state.description && <p className="text-slate-500 text-xs mt-1">{state.description}</p>}
        {service.note && !state.description && (
          <p className="text-slate-600 text-xs mt-1 italic">{service.note}</p>
        )}
      </div>

      {/* DAWA deprecation countdown */}
      {showDawaWarning && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-amber-300 text-xs">
            {da
              ? `DAWA lukker om ${daysUntilDawaDeprecation} dage (1. juli 2026). Sørg for fuld DAR-migration inden da.`
              : `DAWA shuts down in ${daysUntilDawaDeprecation} days (1 July 2026). Complete DAR migration before then.`}
          </p>
        </div>
      )}

      {/* Alert badge for degraded/down */}
      {isAlert && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="text-red-400 shrink-0" />
          <p className="text-red-300 text-xs">
            {da
              ? 'Tjenesten rapporterer problemer — tjek eksternt dashboard.'
              : 'Service reporting issues — check external dashboard.'}
          </p>
        </div>
      )}

      {/* Last checked */}
      {state.checkedAt && (
        <p className="text-slate-600 text-xs flex items-center gap-1 mt-auto">
          <Clock size={11} />
          {da ? 'Tjekket' : 'Checked'}{' '}
          {new Date(state.checkedAt).toLocaleTimeString(da ? 'da-DK' : 'en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </p>
      )}
    </article>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Infrastructure Service Management page.
 *
 * Fetches live health status for all BizzAssist infrastructure components
 * on mount using Promise.allSettled with per-request AbortSignal timeouts.
 * Static services are rendered immediately without network calls.
 *
 * @returns The rendered admin service management page
 */
export default function ServiceManagementClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';

  /** Map from service ID → live status state */
  const [states, setStates] = useState<Record<string, ServiceState>>(() => {
    // Initialise all services to loading (live) or their static status
    const init: Record<string, ServiceState> = {};
    for (const svc of SERVICES) {
      init[svc.id] = {
        status: svc.live ? 'loading' : (svc.staticStatus ?? 'unknown'),
        description: null,
        checkedAt: svc.live ? null : new Date().toISOString(),
      };
    }
    return init;
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  // BIZZ-739: search — aligns layout with /users + /billing
  const [searchQuery, setSearchQuery] = useState('');

  /**
   * Runs all live health checks in parallel with 5 s timeouts.
   * Handles both Statuspage v2 checks (statusUrl) and HTTP ping probes
   * (pingUrl) so services without a Statuspage API still get a live check.
   * BIZZ-377: pingUrl support added for Datafordeleren.
   */
  const runChecks = useCallback(async () => {
    setIsRefreshing(true);

    // Mark live services as loading again
    setStates((prev) => {
      const next = { ...prev };
      for (const svc of SERVICES) {
        if (svc.live) {
          next[svc.id] = { status: 'loading', description: null, checkedAt: null };
        }
      }
      return next;
    });

    // Collect all live services that have a Statuspage URL, ping URL or probe ID
    const liveServices = SERVICES.filter((s) => s.live && (s.statusUrl ?? s.pingUrl ?? s.probeId));

    const results = await Promise.allSettled(
      liveServices.map((svc) => {
        if (svc.statusUrl) return fetchStatuspageStatus(svc.statusUrl);
        if (svc.probeId) return fetchProbeStatus(svc.probeId);
        return fetchPingStatus(svc.pingUrl!);
      })
    );

    setStates((prev) => {
      const next = { ...prev };
      for (let i = 0; i < liveServices.length; i++) {
        const svc = liveServices[i];
        const result = results[i];
        if (result.status === 'fulfilled') {
          next[svc.id] = result.value;
        } else {
          next[svc.id] = {
            status: 'unknown',
            description: da ? 'Statushentning fejlede' : 'Status fetch failed',
            checkedAt: new Date().toISOString(),
          };
        }
      }
      return next;
    });

    setIsRefreshing(false);
  }, [da]);

  /** Run checks once on mount */
  useEffect(() => {
    void runChecks();
    // We intentionally run only on mount — manual refresh via button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived counts for the header summary
  const allStates = Object.values(states);
  const operationalCount = allStates.filter((s) => s.status === 'operational').length;
  const issueCount = allStates.filter((s) => s.status === 'degraded' || s.status === 'down').length;
  const degradedCount = allStates.filter((s) => s.status === 'degraded').length;
  const downCount = allStates.filter((s) => s.status === 'down').length;

  return (
    <div className="min-h-full bg-[#0a1020] text-white">
      <div className="w-full px-4 py-8">
        {/* Back link */}
        <Link
          href="/dashboard/admin/users"
          className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm mb-6 transition-colors"
        >
          <ArrowLeft size={14} />
          {da ? 'Tilbage til admin' : 'Back to admin'}
        </Link>

        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-white text-xl font-bold">
              {da ? 'Infrastruktur & servicestatus' : 'Infrastructure & Service Status'}
            </h1>
            <p className="text-slate-400 text-sm mt-0.5">
              {da
                ? `${operationalCount}/${SERVICES.length} operationelle${issueCount > 0 ? ` · ${issueCount} med problemer` : ''}`
                : `${operationalCount}/${SERVICES.length} operational${issueCount > 0 ? ` · ${issueCount} with issues` : ''}`}
            </p>
          </div>
          <button
            onClick={() => void runChecks()}
            disabled={isRefreshing}
            aria-label={da ? 'Genindlæs statuschecks' : 'Refresh status checks'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 border border-slate-700/50 text-slate-300 hover:text-white hover:border-slate-500 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed self-start"
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
            {da ? 'Opdater' : 'Refresh'}
          </button>
        </div>

        {/* Admin tab navigation — BIZZ-737: shared component */}
        <AdminNavTabs
          activeTab="service-management"
          da={da}
          className="flex gap-1 -mb-px overflow-x-auto mb-6 border-b border-slate-700/50"
        />

        {/* BIZZ-739: KPI stats-cards — matches /dashboard/admin/users + /billing */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs uppercase tracking-wide">
              <Server size={14} className="text-blue-400" />
              {da ? 'Total' : 'Total'}
            </div>
            <p className="text-2xl font-bold text-white">{SERVICES.length}</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs uppercase tracking-wide">
              <Activity size={14} className="text-emerald-400" />
              {da ? 'Operationelle' : 'Operational'}
            </div>
            <p className="text-2xl font-bold text-white">{operationalCount}</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs uppercase tracking-wide">
              <AlertTriangle size={14} className="text-amber-400" />
              {da ? 'Degraderet' : 'Degraded'}
            </div>
            <p className="text-2xl font-bold text-white">{degradedCount}</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs uppercase tracking-wide">
              <AlertTriangle size={14} className="text-red-400" />
              {da ? 'Nede' : 'Down'}
            </div>
            <p className="text-2xl font-bold text-white">{downCount}</p>
          </div>
        </div>

        {/* BIZZ-739: Search — filters the service grid below */}
        <div className="flex gap-3 items-center mb-4">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={da ? 'Søg service…' : 'Search service…'}
              className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg pl-9 pr-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        {/* DAWA global warning (shown once if < 90 days) */}
        {daysUntilDawaDeprecation < 90 && (
          <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-6">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-amber-300 font-medium text-sm">
                {da ? 'DAWA nedlukningsadvarsel' : 'DAWA Deprecation Warning'}
              </p>
              <p className="text-amber-400/80 text-xs mt-0.5">
                {da
                  ? `Danmarks Adresseregister (DAWA) lukker om ${daysUntilDawaDeprecation} dage (1. juli 2026). Sørg for at alle kald er migreret til DAR / Datafordeleren.`
                  : `DAWA shuts down in ${daysUntilDawaDeprecation} days (1 July 2026). Ensure all calls are migrated to DAR / Datafordeleren.`}
              </p>
            </div>
          </div>
        )}

        {/* BIZZ-770: Services split into External (3rd-party APIs) + Internal
            (our own components). Each section is filtered by the same search. */}
        {(() => {
          const filtered = SERVICES.filter((svc) => {
            if (!searchQuery.trim()) return true;
            const q = searchQuery.toLowerCase();
            return svc.name.toLowerCase().includes(q) || svc.id.toLowerCase().includes(q);
          });
          const external = filtered.filter((s) => (s.category ?? 'external') === 'external');
          const internal = filtered.filter((s) => s.category === 'internal');
          return (
            <>
              {external.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-slate-300 text-sm font-semibold flex items-center gap-2">
                    <Globe size={14} className="text-blue-400" />
                    {da ? 'Eksterne interfaces' : 'External interfaces'}
                    <span className="text-slate-500 text-xs font-normal">
                      {da ? `${external.length} services` : `${external.length} services`}
                    </span>
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {external.map((svc) => (
                      <ServiceCard
                        key={svc.id}
                        service={svc}
                        state={
                          states[svc.id] ?? {
                            status: 'unknown',
                            description: null,
                            checkedAt: null,
                          }
                        }
                        da={da}
                      />
                    ))}
                  </div>
                </section>
              )}

              {internal.length > 0 && (
                <section className="space-y-3 mt-8">
                  <h2 className="text-slate-300 text-sm font-semibold flex items-center gap-2">
                    <Server size={14} className="text-purple-400" />
                    {da ? 'Interne komponenter' : 'Internal components'}
                    <span className="text-slate-500 text-xs font-normal">
                      {da
                        ? `${internal.length} komponenter · iter 2 tilføjer live metrics`
                        : `${internal.length} components · iter 2 adds live metrics`}
                    </span>
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {internal.map((svc) => (
                      <ServiceCard
                        key={svc.id}
                        service={svc}
                        state={
                          states[svc.id] ?? {
                            status: 'unknown',
                            description: null,
                            checkedAt: null,
                          }
                        }
                        da={da}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          );
        })()}

        {/* Legend */}
        <div className="flex flex-wrap gap-4 mt-8 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            {da ? 'Operationel' : 'Operational'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            {da ? 'Nedsat ydeevne' : 'Degraded'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-400" />
            {da ? 'Nede' : 'Down'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            {da ? 'Ukendt' : 'Unknown'}
          </span>
          <span className="ml-auto">
            {da ? 'Opdateres manuelt — klik "Opdater"' : 'Updates manually — click "Refresh"'}
          </span>
        </div>
      </div>
    </div>
  );
}
