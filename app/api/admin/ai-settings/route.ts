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
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for PUT /api/admin/ai-settings body */
const aiSettingsPutSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/**
 * Validates that the authenticated caller is an admin user.
 *
 * Uses the anon client to resolve the caller's user.id from the session cookie,
 * then re-fetches the user via the service-role admin client so that
 * app_metadata is read from Supabase's authoritative store rather than the
 * JWT claim embedded in the session token (which could be stale).
 * Admin status is determined solely by `app_metadata.isAdmin` (camelCase boolean)
 * — the canonical field written by the bootstrap route.
 *
 * @returns The authenticated user object if the caller is admin, otherwise null.
 */
async function requireAdmin() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (freshUser?.user?.app_metadata?.isAdmin) return user;
  return null;
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

  const serviceClient = createAdminClient();
  const { data, error } = await serviceClient.from('ai_settings').select('key, value');

  if (error) {
    logger.error('[admin/ai-settings GET] DB error:', error.message);
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

  // Validate request body with Zod schema
  const parsed = await parseBody(req, aiSettingsPutSchema);
  if (!parsed.success) return parsed.response;

  const { key, value } = parsed.data;

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

  const serviceClient = createAdminClient();
  const { error } = await serviceClient
    .from('ai_settings')
    .upsert({ key, value }, { onConflict: 'key' });

  if (error) {
    logger.error('[admin/ai-settings PUT] DB error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  // Audit log — fire-and-forget (ISO 27001 A.12.4)
  void serviceClient.from('audit_log' as never).insert({
    action: 'admin.ai_settings.update',
    resource_type: 'ai_settings',
    resource_id: key,
    metadata: JSON.stringify({ updatedBy: admin.id, key }),
  } as never);

  return NextResponse.json({ success: true });
}
