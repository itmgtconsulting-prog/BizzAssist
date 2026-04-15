/**
 * GET /api/admin/service-status?url=<statuspage-url>
 *
 * Server-side proxy for Statuspage v2 API calls. Avoids CORS issues
 * when fetching from external status pages (Vercel, Supabase, Sentry, etc.).
 *
 * BIZZ-347: Services showed "Ukendt" because browser-side fetch was
 * blocked by CORS. This proxy fetches server-side and returns the JSON.
 *
 * @param url - Statuspage v2 API URL to proxy
 * @returns The Statuspage JSON response
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
  if (!url) return NextResponse.json({ error: 'url parameter required' }, { status: 400 });

  // Whitelist: only allow known statuspage domains
  const allowed = [
    'vercel-status.com',
    'status.supabase.com',
    'status.sentry.io',
    'status.stripe.com',
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
