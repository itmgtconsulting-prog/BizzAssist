/**
 * GET/DELETE /api/auth/sessions
 *
 * BIZZ-1875: Device session management.
 * GET — list active sessions for the authenticated user.
 * DELETE — revoke a specific session by id.
 *
 * @module app/api/auth/sessions/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

/**
 * GET /api/auth/sessions — list active sessions for the current user.
 *
 * @returns { sessions: Array<{ id, device_label, ip_address, last_active, created_at, is_current }> }
 */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('user_sessions')
    .select('id, device_fingerprint, device_label, ip_address, last_active, created_at')
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .order('last_active', { ascending: false });

  if (error) {
    logger.error('[auth/sessions] GET error', { error: error.message });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }

  return NextResponse.json({
    sessions: (data ?? []).map(
      (s: {
        id: string;
        device_fingerprint: string;
        device_label: string | null;
        ip_address: string | null;
        last_active: string;
        created_at: string;
      }) => ({
        id: s.id,
        device_label: s.device_label ?? 'Ukendt enhed',
        ip_address: s.ip_address,
        last_active: s.last_active,
        created_at: s.created_at,
      })
    ),
  });
}

/**
 * DELETE /api/auth/sessions — revoke a session by id.
 *
 * @param body.session_id - UUID of the session to revoke
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
  }

  let sessionId: string;
  try {
    const body = await req.json();
    sessionId = body.session_id;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!sessionId) {
    return NextResponse.json({ error: 'session_id påkrævet' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify session belongs to user
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: session } = await (admin as any)
    .from('user_sessions')
    .select('id, user_id')
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .maybeSingle();

  if (!session) {
    return NextResponse.json({ error: 'Session ikke fundet' }, { status: 404 });
  }

  // Revoke the session
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('user_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', sessionId);

  logger.log('[auth/sessions] Session revoked manually', {
    userId: user.id,
    sessionId,
  });

  return NextResponse.json({ ok: true });
}
