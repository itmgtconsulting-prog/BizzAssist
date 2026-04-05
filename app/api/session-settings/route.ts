/**
 * GET /api/session-settings
 *
 * Returnerer session timeout-indstillinger til dashboard-klienten.
 * Kræver autentificeret session (men ikke admin-rolle) — disse
 * indstillinger er nødvendige for idle-detektionen på klientsiden.
 *
 * @returns JSON med idle_timeout_minutes, absolute_timeout_hours, refresh_token_days
 */

import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** Standardværdier hvis databasen ikke er tilgængelig eller nøglen mangler. */
const DEFAULTS = {
  idle_timeout_minutes: 60,
  absolute_timeout_hours: 24,
  refresh_token_days: 30,
};

export async function GET(): Promise<NextResponse> {
  // Kræv autentificeret bruger
  const cookieStore = await cookies();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {
        /* read-only */
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json(DEFAULTS);
  }

  try {
    const serviceClient = createServiceClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await serviceClient
      .from('ai_settings')
      .select('key, value')
      .in('key', ['idle_timeout_minutes', 'absolute_timeout_hours', 'refresh_token_days']);

    const result = { ...DEFAULTS };
    for (const row of data ?? []) {
      const numVal = typeof row.value === 'number' ? row.value : Number(row.value);
      if (!isNaN(numVal)) {
        (result as Record<string, number>)[row.key] = numVal;
      }
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(DEFAULTS);
  }
}
