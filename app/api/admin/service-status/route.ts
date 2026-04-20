/**
 * GET /api/admin/service-status?url=<statuspage-url>
 * GET /api/admin/service-status?ping=<health-url>
 * GET /api/admin/service-status?probe=<serviceId>
 *
 * Server-side proxy for three types of service health checks:
 *
 * 1. `?url=` — Proxies a Statuspage v2 /api/v2/status.json endpoint.
 *    Avoids CORS issues when fetching from external status pages
 *    (Vercel, Supabase, Anthropic, Stripe, Mapbox, etc.).
 *    Returns the raw Statuspage JSON response.
 *
 * 2. `?ping=` — Simple HTTP HEAD probe for services without a Statuspage API.
 *    Returns `{ ok: true, httpStatus: <n> }` on success or
 *    `{ ok: false, httpStatus: <n> }` on failure.
 *
 * 3. `?probe=<serviceId>` — Authenticated probe using server-side credentials.
 *    Supports: datafordeler, upstash, resend, cvr, brave, mediastack, twilio.
 *    Returns `{ ok: boolean, httpStatus: number, detail?: string }`.
 *    Credentials stay on the server — never sent to the browser.
 *
 * BIZZ-347: Added proxy to solve browser CORS blocking for Statuspage fetches.
 * BIZZ-377: Added Anthropic/Mapbox Statuspage whitelist + Datafordeler ping.
 * BIZZ-622: Added authenticated `?probe=` mode for services without a public
 *   Statuspage API (Upstash, Resend, CVR ES, Brave, Mediastack, Twilio) plus
 *   Basic-Auth'd Datafordeler probe that treats HTTP 200 as operational. Also
 *   added richer logging for Statuspage fetch failures so production errors
 *   can be diagnosed without raw upstream responses reaching the client.
 *
 * @param url   - Statuspage v2 API URL to proxy (mutually exclusive)
 * @param ping  - URL to HEAD-probe (mutually exclusive)
 * @param probe - Service ID to run an authenticated probe for (mutually exclusive)
 * @returns Statuspage JSON (url mode) or `{ ok, httpStatus, detail? }` (ping/probe)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { parseQuery } from '@/app/lib/validate';

/** Known service IDs that support authenticated server-side probes. */
const probeIds = [
  'datafordeler',
  'upstash',
  'resend',
  'cvr',
  'brave',
  'mediastack',
  'twilio',
] as const;
type ProbeId = (typeof probeIds)[number];

/** Zod schema — exactly one of url / ping / probe required */
const querySchema = z
  .object({
    url: z.string().url().optional(),
    ping: z.string().url().optional(),
    probe: z.enum(probeIds).optional(),
  })
  .refine((d) => (d.url ? 1 : 0) + (d.ping ? 1 : 0) + (d.probe ? 1 : 0) === 1, {
    message: 'Exactly one of url, ping, probe required',
  });

/** Shape returned by ping/probe modes. */
interface ProbeResult {
  ok: boolean;
  httpStatus: number;
  detail?: string;
}

/**
 * Small helper — timed fetch with safe catch so a probe never throws out of
 * the registry. Any network/abort error is converted to `{ ok: false }`.
 */
async function safeFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const { timeoutMs = 5000, ...rest } = init;
  try {
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      detail: err instanceof Error ? err.name : 'fetch_error',
    };
  }
}

/**
 * Authenticated server-side probes. Each entry returns operational iff the
 * upstream service answered with a 2xx to an authenticated request. Missing
 * credentials return `{ ok: false, detail: 'missing_credentials' }` so the
 * admin UI can surface that as "Ukendt" rather than a false "Operational".
 */
const probes: Record<ProbeId, () => Promise<ProbeResult>> = {
  // Datafordeler requires HTTP Basic Auth on every request. A bare HEAD to
  // the root returns 401 (server alive). With Basic Auth we expect 200 from
  // a cheap BBR schema endpoint.
  datafordeler: async () => {
    const user = process.env.DATAFORDELER_USER;
    const pass = process.env.DATAFORDELER_PASS;
    if (!user || !pass) return { ok: false, httpStatus: 0, detail: 'missing_credentials' };
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    // Cheap schema introspection call — tiny response.
    return safeFetch('https://services.datafordeler.dk/BBR/BBRPublic/1/rest/?service=BBR', {
      method: 'HEAD',
      headers: { Authorization: `Basic ${auth}` },
    });
  },

  // Upstash Redis REST — PING returns `{ result: 'PONG' }`.
  upstash: async () => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return { ok: false, httpStatus: 0, detail: 'missing_credentials' };
    return safeFetch(`${url.replace(/\/$/, '')}/ping`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  // Resend: GET /domains — cheap auth check that lists zero-or-more domains.
  resend: async () => {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { ok: false, httpStatus: 0, detail: 'missing_credentials' };
    return safeFetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` },
    });
  },

  // CVR distribution ES — tiny single-doc search. Uses ES Basic Auth.
  cvr: async () => {
    const user = process.env.CVR_ES_USER;
    const pass = process.env.CVR_ES_PASS;
    // CVR endpoint is public for basic search — auth is required only for
    // sustained use. Try anonymous probe first; fall back to creds if set.
    const init: RequestInit = { method: 'HEAD' };
    if (user && pass) {
      init.headers = {
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
      };
    }
    return safeFetch('http://distribution.virk.dk/cvr-permanent/_search?size=1', init);
  },

  // Brave Search — small `q=ping` query with X-Subscription-Token.
  brave: async () => {
    const key = process.env.BRAVE_SEARCH_API_KEY;
    if (!key) return { ok: false, httpStatus: 0, detail: 'missing_credentials' };
    return safeFetch('https://api.search.brave.com/res/v1/web/search?q=ping&count=1', {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    });
  },

  // Mediastack — cheap news query with access_key in query string.
  mediastack: async () => {
    const key = process.env.MEDIASTACK_API_KEY;
    if (!key) return { ok: false, httpStatus: 0, detail: 'missing_credentials' };
    return safeFetch(
      `http://api.mediastack.com/v1/news?access_key=${encodeURIComponent(key)}&limit=1`
    );
  },

  // Twilio — GET /Accounts/{sid}.json; 200 = operational.
  twilio: async () => {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return { ok: false, httpStatus: 0, detail: 'missing_credentials' };
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    return safeFetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });
  },
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Admin-only endpoint
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (!freshUser?.user?.app_metadata?.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = parseQuery(request, querySchema);
  if (!parsed.success) return parsed.response;
  const { url, ping, probe } = parsed.data;

  // ── Statuspage v2 proxy mode ────────────────────────────────────────────────
  if (url) {
    // Whitelist: only allow known Statuspage v2 domains.
    // BIZZ-377: Added status.anthropic.com and status.mapbox.com which were
    // missing, causing those services to always return 403 → "Ukendt" in the UI.
    const allowed = [
      'vercel-status.com',
      'status.supabase.com',
      'status.sentry.io',
      'status.stripe.com',
      'status.anthropic.com',
      'status.mapbox.com',
      'status.resend.com',
      'status.upstash.com',
    ];
    try {
      const parsedUrl = new URL(url);
      if (!allowed.some((d) => parsedUrl.hostname.endsWith(d))) {
        return NextResponse.json({ error: 'Domain not allowed' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        // BIZZ-622: richer logging so intermittent Statuspage failures can be
        // diagnosed. We still never leak raw upstream bodies to the client.
        logger.warn('[service-status] Upstream non-2xx', {
          host: new URL(url).host,
          status: res.status,
        });
        return NextResponse.json({ error: `Upstream ${res.status}` }, { status: 502 });
      }
      const data = await res.json();
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' },
      });
    } catch (err) {
      logger.error('[service-status] Proxy error', {
        host: (() => {
          try {
            return new URL(url).host;
          } catch {
            return 'invalid_url';
          }
        })(),
        error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
      });
      return NextResponse.json({ error: 'Upstream fetch failed' }, { status: 502 });
    }
  }

  // ── Authenticated probe mode ────────────────────────────────────────────────
  if (probe) {
    const fn = probes[probe];
    try {
      const result = await fn();
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' },
      });
    } catch (err) {
      logger.error('[service-status] Probe error', {
        probe,
        error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
      });
      return NextResponse.json(
        { ok: false, httpStatus: 0, detail: 'probe_exception' },
        { status: 200 }
      );
    }
  }

  // ── HTTP ping probe mode ────────────────────────────────────────────────────
  // Used for services that have no Statuspage API and no credentials.

  const pingAllowed = ['api.datafordeler.dk', 'datafordeler.dk'];

  let parsedPing: URL;
  try {
    parsedPing = new URL(ping!);
    if (!pingAllowed.some((d) => parsedPing.hostname.endsWith(d))) {
      return NextResponse.json({ error: 'Domain not allowed' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid ping URL' }, { status: 400 });
  }

  try {
    const res = await fetch(parsedPing.toString(), {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
    });
    // BIZZ-622: Datafordeler root returns 401 because Basic Auth is required —
    // but a 401 still proves the server is reachable and answering. Treat any
    // non-5xx response as "server reachable".
    const reachable = res.status > 0 && res.status < 500;
    return NextResponse.json(
      { ok: reachable, httpStatus: res.status },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' } }
    );
  } catch (err) {
    logger.error('[service-status] Ping probe error', {
      host: parsedPing.host,
      error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
    });
    return NextResponse.json({ ok: false, httpStatus: 0 }, { status: 200 });
  }
}
