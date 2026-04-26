/**
 * POST /api/team/accept — acceptér en team-invitation og join tenant.
 *
 * Body: { token: string }
 *
 * BIZZ-271: Caller skal være logget ind som en bruger hvis email matcher
 * invitation-rowen (case-insensitive). Token skal være unik, ikke udløbet,
 * og ikke allerede accepteret. Ved succes oprettes tenant_membership-
 * row og invitation markeres accepted_at.
 *
 * For unauthenticated calls: returnerer 401 så klienten kan redirecte til
 * /login?next=/team/accept?token=... — login-flow bringer user tilbage og
 * vi accepterer invitationen bagefter.
 *
 * @module app/api/team/accept
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveUserId } from '@/lib/api/auth';
import { writeAuditLog } from '@/app/lib/auditLog';
import { logger } from '@/app/lib/logger';

const acceptSchema = z.object({
  token: z.string().min(10).max(100),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await resolveUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }
  const parsed = acceptSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Input-fejl' }, { status: 400 });
  }

  const { token } = parsed.data;

  try {
    const admin = createAdminClient();

    // Hent invitation via token
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: invite } = (await (admin as any)
      .from('tenant_invitations')
      .select('id, tenant_id, email, role, expires_at, accepted_at')
      .eq('token', token)
      .maybeSingle()) as {
      data: {
        id: string;
        tenant_id: string;
        email: string;
        role: string;
        expires_at: string;
        accepted_at: string | null;
      } | null;
    };

    if (!invite) {
      return NextResponse.json({ error: 'Ugyldig invitation-token' }, { status: 404 });
    }
    if (invite.accepted_at) {
      return NextResponse.json({ error: 'Invitationen er allerede accepteret' }, { status: 410 });
    }
    if (new Date(invite.expires_at) < new Date()) {
      return NextResponse.json(
        { error: 'Invitationen er udløbet. Bed admin om en ny.' },
        { status: 410 }
      );
    }

    // Verificér at user's email matcher invitationens email (case-insensitive)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: user } = (await (admin as any)
      .from('users')
      .select('email')
      .eq('id', userId)
      .maybeSingle()) as { data: { email: string } | null };

    if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return NextResponse.json(
        { error: 'Invitationens email matcher ikke din konto' },
        { status: 403 }
      );
    }

    // Opret tenant_membership (ON CONFLICT DO NOTHING — user kan allerede
    // være medlem hvis race-condition eller duplicate accept).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('tenant_memberships')
      .upsert(
        { tenant_id: invite.tenant_id, user_id: userId, role: invite.role },
        { onConflict: 'tenant_id,user_id', ignoreDuplicates: true }
      );

    // Mark invitation accepted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('tenant_invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id);

    void writeAuditLog({
      action: 'team.invite_accepted',
      resource_type: 'tenant_invitation',
      resource_id: invite.id,
      metadata: JSON.stringify({
        tenant_id: invite.tenant_id,
        role: invite.role,
      }),
    });

    return NextResponse.json({ success: true, tenant_id: invite.tenant_id });
  } catch (err) {
    logger.error('[team/accept]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
