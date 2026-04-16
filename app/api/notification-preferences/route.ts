/**
 * GET/PUT /api/notification-preferences
 *
 * Manages notification preferences for the authenticated user.
 * Preferences are stored in Supabase user_metadata for simplicity
 * (avoids per-tenant schema migration).
 *
 * BIZZ-273: Notification preferences API.
 *
 * GET — returns current preferences
 * PUT — updates preferences { preferences: Record<string, boolean> }
 *
 * @returns { preferences: Record<string, boolean> }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '@/app/lib/validate';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { writeAuditLog } from '@/app/lib/auditLog';

/** Default notification preferences — all enabled */
const DEFAULT_PREFERENCES: Record<string, boolean> = {
  property_valuation_changed: true,
  property_owner_changed: true,
  subscription_renewed: true,
  subscription_expiring: true,
  system_alert: true,
};

const putSchema = z
  .object({
    preferences: z.record(z.string(), z.boolean()),
  })
  .passthrough();

/**
 * GET /api/notification-preferences
 * Returns the user's notification preferences.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const saved = user.user_metadata?.notification_preferences as Record<string, boolean> | undefined;
  return NextResponse.json({
    preferences: { ...DEFAULT_PREFERENCES, ...saved },
  });
}

/**
 * PUT /api/notification-preferences
 * Updates the user's notification preferences.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = await parseBody(request, putSchema);
  if (!parsed.success) return parsed.response;

  const { error } = await supabase.auth.updateUser({
    data: {
      ...user.user_metadata,
      notification_preferences: parsed.data.preferences,
    },
  });

  if (error) {
    return NextResponse.json({ error: 'Kunne ikke gemme præferencer' }, { status: 500 });
  }

  writeAuditLog({
    action: 'notification_preferences.update',
    resource_type: 'user_preferences',
    resource_id: user.id,
  });

  return NextResponse.json({ ok: true, preferences: parsed.data.preferences });
}
