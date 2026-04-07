/**
 * GET  /api/admin/ai-settings
 *   Returnerer alle AI-indstillinger fra ai_settings-tabellen.
 *   Kræver autentificeret bruger med admin-rolle.
 *
 * PUT  /api/admin/ai-settings
 *   Body: { key: string, value: unknown }
 *   Opdaterer én indstilling. Kræver admin-rolle.
 *
 * @returns JSON-objekt med alle settings (GET) eller { success: true } (PUT)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * Returnerer Supabase server-client med cookie-baseret session (bruger-auth).
 */
async function getSessionClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {
        /* read-only i route handlers */
      },
    },
  });
}

/**
 * Validerer at den autentificerede bruger har admin-rolle.
 * Admin defineres som rollen 'admin' i user_metadata eller app_metadata.
 *
 * @returns user-objekt hvis admin, null ellers
 */
async function requireAdmin() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const sessionClient = await getSessionClient();
  const {
    data: { user },
  } = await sessionClient.auth.getUser();
  if (!user) return null;

  // Tjek admin-rolle i metadata
  const isAdmin =
    user.app_metadata?.role === 'admin' ||
    user.user_metadata?.role === 'admin' ||
    user.app_metadata?.is_admin === true;

  return isAdmin ? user : null;
}

// ─── GET ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/ai-settings
 * Returnerer alle AI-indstillinger som { key: value } objekt.
 */
export async function GET(_req: NextRequest) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    // Returnér default-værdier hvis Supabase ikke er konfigureret
    return NextResponse.json({
      min_confidence_threshold: 70,
      confidence_levels: { hide: 70, uncertain: 85, confident: 100 },
    });
  }

  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data, error } = await serviceClient.from('ai_settings').select('key, value');

  if (error) {
    console.error('[admin/ai-settings GET] DB error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  // Flad ud til { key: value } objekt for nem brug i frontend
  const result: Record<string, unknown> = {};
  for (const row of data ?? []) {
    result[row.key] = row.value;
  }

  return NextResponse.json(result);
}

// ─── PUT ─────────────────────────────────────────────────────────────────────

/**
 * PUT /api/admin/ai-settings
 * Body: { key: string, value: unknown }
 * Upsert én indstilling — opretter hvis ikke eksisterer, opdaterer ellers.
 */
export async function PUT(req: NextRequest) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json({ error: 'Supabase ikke konfigureret' }, { status: 503 });
  }

  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
  }

  let body: { key?: string; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { key, value } = body;
  if (!key || value === undefined) {
    return NextResponse.json({ error: 'key og value er påkrævet' }, { status: 400 });
  }

  // Tillad kun kendte nøgler for at forhindre utilsigtede indstillinger
  const ALLOWED_KEYS = [
    'min_confidence_threshold',
    'confidence_levels',
    // Blokerede domæner
    'excluded_domains',
    // Virksomheds-agent
    'brave_api_key',
    'primary_media_domains',
    'max_articles_per_search',
    'max_tokens_per_search',
    // Person-agent
    'person_contact_search_enabled',
    'person_phone_fallback_enabled',
    'person_social_platforms',
    // Session timeout (migration 018)
    'idle_timeout_minutes',
    'absolute_timeout_hours',
    'refresh_token_days',
  ];
  if (!ALLOWED_KEYS.includes(key)) {
    return NextResponse.json(
      { error: `Ukendt nøgle: ${key}. Tilladte: ${ALLOWED_KEYS.join(', ')}` },
      { status: 400 }
    );
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error } = await serviceClient
    .from('ai_settings')
    .upsert({ key, value }, { onConflict: 'key' });

  if (error) {
    console.error('[admin/ai-settings PUT] DB error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
