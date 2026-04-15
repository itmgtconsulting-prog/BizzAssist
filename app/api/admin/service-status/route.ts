/**
 * GET /api/admin/service-status?url=<statuspage-url>
 * GET /api/admin/service-status?ping=<health-url>
 *
 * Server-side proxy for two types of service health checks:
 *
 * 1. `?url=` — Proxies a Statuspage v2 /api/v2/status.json endpoint.
 *    Avoids CORS issues when fetching from external status pages
 *    (Vercel, Supabase, Anthropic, Stripe, Mapbox, etc.).
 *    Returns the raw Statuspage JSON response.
 *
 * 2. `?ping=` — Simple HTTP HEAD probe for services without a Statuspage API
 *    (e.g. Datafordeleren). Returns `{ ok: true, httpStatus: <n> }` on
 *    success or `{ ok: false, httpStatus: <n> }` on failure.
 *
 * BIZZ-347: Services showed "Ukendt" because browser-side fetch was
 * blocked by CORS. This proxy fetches server-side.
 *
 * BIZZ-377: Added status.anthropic.com and status.mapbox.com to the
 * Statuspage whitelist, and added a ping whitelist for Datafordeleren.
 *
 * @param url  - Statuspage v2 API URL to proxy (mutually exclusive with ping)
 * @param ping - URL to HEAD-probe (mutually exclusive with url)
 * @returns Statuspage JSON (url mode) or `{ ok, httpStatus }` (ping mode)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

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

  const url = request.nextUrl.searchParams.get('url');
  const ping = request.nextUrl.searchParams.get('ping');

  if (!url && !ping) {
    return NextResponse.json({ error: 'url or ping parameter required' }, { status: 400 });
  }

  // ── Statuspage v2 proxy mode ─────────────────────────────────────────────────
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
      const parsed = new URL(url);
      if (!allowed.some((d) => parsed.hostname.endsWith(d))) {
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
        return NextResponse.json({ error: `Upstream ${res.status}` }, { status: 502 });
      }
      const data = await res.json();
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' },
      });
    } catch (err) {
      logger.error('[service-status] Proxy error:', err);
      return NextResponse.json({ error: 'Upstream fetch failed' }, { status: 502 });
    }
  }

  // ── HTTP ping probe mode ─────────────────────────────────────────────────────
  // BIZZ-377: Used for services that have no Statuspage API (e.g. Datafordeleren).
  // Performs a HEAD request and reports back the HTTP status code.

  // Whitelist for ping targets — only allow known BizzAssist dependency domains.
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
    return NextResponse.json(
      { ok: res.ok, httpStatus: res.status },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' } }
    );
  } catch (err) {
    logger.error('[service-status] Ping probe error:', err);
    return NextResponse.json({ ok: false, httpStatus: 0 }, { status: 200 });
  }
}
