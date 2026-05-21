/**
 * POST /api/proxy/supabase-auth
 *
 * BIZZ-1702: Proxy for Supabase auth calls fra Hetzner.
 * Hetzner IP er blokeret af Cloudflare WAF for direkte Supabase auth.
 * Denne route kører på Vercel (ikke blokeret) og forwarder auth-requests.
 *
 * Sikkerhed: Kræver PROXY_SECRET header for at forhindre misbrug.
 * Kun signInWithPassword og admin user-updates er tilladte.
 *
 * @module api/proxy/supabase-auth
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';

export const maxDuration = 15;

/**
 * POST handler — proxy auth request til Supabase.
 *
 * Body: { action: 'signIn' | 'adminUpdateUser', email?, password?, userId?, data? }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Verify proxy secret
  const secret = request.headers.get('x-proxy-secret');
  const expectedSecret = process.env.SUPABASE_AUTH_PROXY_SECRET ?? process.env.CRON_SECRET;
  if (!secret || !expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    action: string;
    email?: string;
    password?: string;
    userId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 });
  }

  try {
    switch (body.action) {
      case 'signIn': {
        if (!body.email || !body.password) {
          return NextResponse.json({ error: 'Missing email/password' }, { status: 400 });
        }
        const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: {
            apikey: anonKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email: body.email, password: body.password }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
      }

      case 'adminUpdateUser': {
        if (!body.userId || !body.password || !serviceKey) {
          return NextResponse.json(
            { error: 'Missing userId/password/serviceKey' },
            { status: 400 }
          );
        }
        const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${body.userId}`, {
          method: 'PUT',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ password: body.password }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    logger.error('[proxy/supabase-auth]', err);
    return NextResponse.json({ error: 'Proxy error' }, { status: 502 });
  }
}
