/**
 * GET /api/session-settings
 *
 * Returnerer session timeout-indstillinger til dashboard-klienten.
 * Prioritering: bruger-specifik præference → global ai_settings → hardcoded defaults.
 * Kræver autentificeret session.
 *
 * PUT /api/session-settings
 *
 * Gemmer brugerens ønskede idle_timeout_minutes (15–480).
 * Logger ændringen til audit_log.
 *
 * @returns JSON med idle_timeout_minutes, absolute_timeout_hours, refresh_token_days
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** Hardcoded defaults — fallback når DB ikke er tilgængelig. */
const DEFAULTS = {
  idle_timeout_minutes: 60,
  absolute_timeout_hours: 24,
  refresh_token_days: 30,
};

/** Max timeout der accepteres fra brugeren (ISO 27001 compliance). */
const MAX_IDLE_MINUTES = 480;
/** Min timeout der accepteres fra brugeren. */
const MIN_IDLE_MINUTES = 15;

/**
 * Henter autentificeret bruger og service-klient.
 * Returnerer null hvis bruger ikke er autentificeret.
 */
async function resolveUserAndClient(): Promise<{
  userId: string;
  serviceClient: ReturnType<typeof createServiceClient>;
} | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {},
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return {
    userId: user.id,
    serviceClient: createServiceClient(SUPABASE_URL, SUPABASE_SERVICE_KEY),
  };
}

export async function GET(): Promise<NextResponse> {
  const ctx = await resolveUserAndClient();
  if (!ctx) {
    // Return defaults rather than 401 — hook needs fallback values even on edge errors
    return NextResponse.json(DEFAULTS, { status: 401 });
  }
  const { userId, serviceClient } = ctx;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = serviceClient as any;

  try {
    // 1. Hent global defaults fra ai_settings
    const { data: globalRows } = await svc
      .from('ai_settings')
      .select('key, value')
      .in('key', ['idle_timeout_minutes', 'absolute_timeout_hours', 'refresh_token_days']);

    const result = { ...DEFAULTS };
    for (const row of (globalRows ?? []) as Array<{ key: string; value: unknown }>) {
      const numVal = typeof row.value === 'number' ? row.value : Number(row.value);
      if (!isNaN(numVal)) {
        (result as Record<string, number>)[row.key] = numVal;
      }
    }

    // 2. BIZZ-1874: Override idle_timeout_minutes med bruger-specifik præference
    const { data: userPref } = await svc
      .from('user_session_preferences')
      .select('idle_timeout_minutes')
      .eq('user_id', userId)
      .maybeSingle();

    const pref = userPref as { idle_timeout_minutes?: number } | null;
    if (pref?.idle_timeout_minutes) {
      result.idle_timeout_minutes = pref.idle_timeout_minutes;
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(DEFAULTS);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const ctx = await resolveUserAndClient();
  if (!ctx) {
    return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
  }
  const { userId, serviceClient } = ctx;

  let body: { idle_timeout_minutes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const minutes = Number(body.idle_timeout_minutes);
  if (isNaN(minutes) || minutes < MIN_IDLE_MINUTES || minutes > MAX_IDLE_MINUTES) {
    return NextResponse.json(
      { error: `idle_timeout_minutes skal være mellem ${MIN_IDLE_MINUTES} og ${MAX_IDLE_MINUTES}` },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svcPut = serviceClient as any;

  try {
    // Upsert bruger-præference
    const { error: upsertErr } = await svcPut
      .from('user_session_preferences')
      .upsert(
        { user_id: userId, idle_timeout_minutes: minutes, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );

    if (upsertErr) {
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // Audit log — public schema, tenant_id NULL for user-level settings
    try {
      await svcPut.from('audit_log').insert({
        tenant_id: null,
        user_id: userId,
        action: 'update_session_timeout',
        resource_type: 'user_session_preferences',
        resource_id: userId,
        metadata: { idle_timeout_minutes: minutes },
      });
    } catch {
      /* Audit log fejl er non-fatal */
    }

    return NextResponse.json({ idle_timeout_minutes: minutes });
  } catch {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
