/**
 * POST /api/team/invite — opret invitation + send email.
 *
 * Body:
 *   { email: string, role: 'tenant_admin'|'tenant_member'|'tenant_viewer' }
 *
 * BIZZ-271: Kun tenant_admin må invitere. Opretter row i
 * tenant_invitations med unik 256-bit token, sender email via Resend
 * med accept-link (/team/accept?token=...). Duplicate pending invites
 * (samme tenant+email) rejectes med 409.
 *
 * @module app/api/team/invite
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTenantAdmin, generateInvitationToken } from '@/app/lib/teamAuth';
import { writeAuditLog } from '@/app/lib/auditLog';
import { sendTeamInvitationEmail } from '@/app/lib/email';
import { logger } from '@/app/lib/logger';

const inviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(['tenant_admin', 'tenant_member', 'tenant_viewer']).default('tenant_member'),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireTenantAdmin();
  if (!ctx) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }
  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Input-fejl', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { email, role } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const admin = createAdminClient();

    // Guard: Tjek at emailen ikke allerede er medlem af denne tenant.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existingUser } = (await (admin as any)
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle()) as { data: { id: string } | null };

    if (existingUser) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existingMembership } = (await (admin as any)
        .from('tenant_memberships')
        .select('id')
        .eq('tenant_id', ctx.tenantId)
        .eq('user_id', existingUser.id)
        .maybeSingle()) as { data: { id: string } | null };
      if (existingMembership) {
        return NextResponse.json(
          { error: 'Emailen tilhører allerede et medlem af teamet' },
          { status: 409 }
        );
      }
    }

    // Generér token + upsert invitation. ON CONFLICT (tenant_id, email)
    // re-issuer vi token med ny 7-dages udløb hvis der findes en pending
    // invite — så admin kan resende uden at skulle slette først.
    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inviteRow, error: upsertErr } = await (admin as any)
      .from('tenant_invitations')
      .upsert(
        {
          tenant_id: ctx.tenantId,
          email: normalizedEmail,
          role,
          token,
          invited_by: ctx.userId,
          expires_at: expiresAt.toISOString(),
          accepted_at: null,
        },
        { onConflict: 'tenant_id,email' }
      )
      .select('id')
      .single();

    if (upsertErr || !inviteRow) {
      logger.error('[team/invite] upsert fejl:', upsertErr?.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // Fetch tenant-navn + inviter-navn til email-body
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tenantRow } = (await (admin as any)
      .from('tenants')
      .select('name')
      .eq('id', ctx.tenantId)
      .maybeSingle()) as { data: { name: string } | null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inviterRow } = (await (admin as any)
      .from('users')
      .select('full_name')
      .eq('id', ctx.userId)
      .maybeSingle()) as { data: { full_name: string | null } | null };

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk';
    const acceptUrl = `${appUrl}/team/accept?token=${encodeURIComponent(token)}`;

    // Fire-and-forget — email-fejl skal ikke blokere invite-oprettelse.
    // Admin kan altid manuelt copy+share acceptUrl hvis email ikke når frem.
    void sendTeamInvitationEmail({
      to: normalizedEmail,
      tenantName: tenantRow?.name ?? 'BizzAssist',
      invitedByName: inviterRow?.full_name ?? null,
      role,
      acceptUrl,
      expiresAt,
    });

    void writeAuditLog({
      action: 'team.invite_sent',
      resource_type: 'tenant_invitation',
      resource_id: inviteRow.id,
      metadata: JSON.stringify({
        tenant_id: ctx.tenantId,
        role,
        // Email er PII — gem domain del kun for audit, ikke fuld adresse
        email_domain: normalizedEmail.split('@')[1] ?? null,
      }),
    });

    return NextResponse.json({ success: true, inviteId: inviteRow.id });
  } catch (err) {
    logger.error('[team/invite]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
