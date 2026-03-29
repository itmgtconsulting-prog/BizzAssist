/**
 * User Preferences API — /api/preferences
 *
 * Handles user preferences stored in public.users table.
 * Includes language preference and JSONB preferences (map style, etc.).
 *
 * GET  /api/preferences           — get user preferences
 * PUT  /api/preferences { ... }   — update preferences
 *
 * @module api/preferences
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/preferences
 *
 * Returns the authenticated user's preferences.
 */
export async function GET() {
  const userId = await resolveUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Ikke logget ind' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('users')
      .select('preferred_language, preferences')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return NextResponse.json({
        language: 'da',
        preferences: {},
      });
    }

    return NextResponse.json({
      language: data.preferred_language ?? 'da',
      preferences: data.preferences ?? {},
    });
  } catch (err) {
    console.error('[preferences GET]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

/**
 * PUT /api/preferences
 *
 * Updates user preferences. Supports partial updates.
 * Body: { language?, mapStyle?, ...otherPrefs }
 */
export async function PUT(request: NextRequest) {
  const userId = await resolveUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Ikke logget ind' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const admin = createAdminClient();

    // Build update object
    const updates: Record<string, unknown> = {};

    // Language goes in its own column
    if (body.language && (body.language === 'da' || body.language === 'en')) {
      updates.preferred_language = body.language;
    }

    // Everything else merges into the preferences JSONB
    if (body.mapStyle || body.preferences) {
      // Fetch current preferences to merge
      const { data: current } = await admin
        .from('users')
        .select('preferences')
        .eq('id', userId)
        .single();

      const currentPrefs = (current?.preferences as Record<string, unknown>) ?? {};
      const newPrefs = { ...currentPrefs };

      if (body.mapStyle) {
        newPrefs.mapStyle = body.mapStyle;
      }
      if (body.preferences && typeof body.preferences === 'object') {
        Object.assign(newPrefs, body.preferences);
      }

      updates.preferences = newPrefs;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Ingen ændringer' }, { status: 400 });
    }

    const { error } = await admin.from('users').update(updates).eq('id', userId);

    if (error) {
      console.error('[preferences PUT] Supabase error:', error);
      return NextResponse.json({ error: 'Kunne ikke gemme' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[preferences PUT]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
