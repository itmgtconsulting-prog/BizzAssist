/**
 * DELETE /api/team/invitations/[id] — admin annullerer pending invitation.
 *
 * BIZZ-271: Admin kan revoke en invitation der ikke er accepteret endnu.
 * Efter delete kan emailen re-inviteres (tabellen UNIQUE constraint clearet).
 * Accept-URL'en holder op med at virke fordi token-lookup returnerer null.
 *
 * @module app/api/team/invitations/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTenantAdmin } from '@/app/lib/teamAuth';
import { writeAuditLog } from '@/app/lib/auditLog';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const ctx = await requireTenantAdmin();
  if (!ctx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await context.params;

  try {
    const admin = createAdminClient();
    // Ejer-check: invitation skal være i caller's tenant — forhindrer
    // cross-tenant revoke via id-guessing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = (await (admin as any)
      .from('tenant_invitations')
      .select('id, tenant_id, email, accepted_at')
      .eq('id', id)
      .maybeSingle()) as {
      data: { id: string; tenant_id: string; email: string; accepted_at: string | null } | null;
    };

    if (!existing) {
      return NextResponse.json({ error: 'Invitation ikke fundet' }, { status: 404 });
    }
    if (existing.tenant_id !== ctx.tenantId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (existing.accepted_at) {
      return NextResponse.json(
        {
          error:
            'Invitation er allerede accepteret og kan ikke annulleres. Brug DELETE /api/team/[userId] i stedet.',
        },
        { status: 409 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any).from('tenant_invitations').delete().eq('id', id);
    if (error) {
      logger.error('[team/invitations DELETE] db error:', error.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    void writeAuditLog({
      action: 'team.invite_revoked',
      resource_type: 'tenant_invitation',
      resource_id: id,
      metadata: JSON.stringify({
        tenant_id: ctx.tenantId,
        email_domain: existing.email.split('@')[1] ?? null,
      }),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[team/invitations DELETE]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
