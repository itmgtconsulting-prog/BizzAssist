/**
 * Notifikationer API — /api/notifications
 *
 * Håndterer CRUD for brugerens notifikationer.
 * Bruger Supabase via tenant context når auth er tilgængelig,
 * ellers falder tilbage til en tom respons (localStorage-MVP
 * håndterer offline-scenariet i klienten).
 *
 * GET  /api/notifications              — hent notifikationer
 * GET  /api/notifications?count=true   — antal ulæste
 * POST /api/notifications { action }   — marker læst, slet læste
 *
 * @module api/notifications
 */
import { NextRequest, NextResponse } from 'next/server';
import { writeAuditLog } from '@/app/lib/auditLog';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { getTenantContext } from '@/lib/db/tenant';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/app/lib/logger';

/**
 * Resolver tenant ID fra den autentificerede brugers session.
 * Returnerer null hvis bruger ikke er logget ind eller ikke har en tenant.
 */
async function resolveTenantId(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data } = (await supabase
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1)
      .single()) as { data: { tenant_id: string } | null };
    return data?.tenant_id ?? null;
  } catch {
    return null;
  }
}

/**
 * GET /api/notifications
 *
 * Henter brugerens notifikationer fra Supabase.
 * Query params:
 *   - count=true: returnerer kun antal ulæste
 *   - unread=true: kun ulæste
 *   - limit=N: max antal (default 50)
 */
export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ notifications: [], unreadCount: 0 });
  }

  try {
    const ctx = await getTenantContext(tenantId);
    const { searchParams } = new URL(request.url);

    if (searchParams.get('count') === 'true') {
      const count = await ctx.notifications.countUnread();
      return NextResponse.json({ unreadCount: count });
    }

    const unreadOnly = searchParams.get('unread') === 'true';
    const limit = parseInt(searchParams.get('limit') ?? '50', 10);
    const notifications = await ctx.notifications.list({ unread_only: unreadOnly, limit });
    return NextResponse.json({ notifications });
  } catch (err) {
    logger.error('[notifications GET]', err);
    return NextResponse.json({ notifications: [], unreadCount: 0 });
  }
}

/**
 * POST /api/notifications
 *
 * Handlinger på notifikationer:
 *   { action: 'mark_read', id: 'uuid' }
 *   { action: 'mark_all_read' }
 *   { action: 'delete_read' }
 */
export async function POST(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: 'Ikke logget ind' }, { status: 401 });
  }

  try {
    const ctx = await getTenantContext(tenantId);
    const body = await request.json();
    const action = body?.action;

    switch (action) {
      case 'mark_read':
        if (!body.id) return NextResponse.json({ error: 'Mangler id' }, { status: 400 });
        await ctx.notifications.markAsRead(body.id);
        break;
      case 'mark_all_read':
        await ctx.notifications.markAllAsRead();
        break;
      case 'delete_read':
        await ctx.notifications.deleteRead();
        break;
      default:
        return NextResponse.json({ error: `Ukendt action: ${action}` }, { status: 400 });
    }

    // BIZZ-289: Audit log for notification write operations
    writeAuditLog({
      action: `notification.${action}`,
      resource_type: 'notification',
      resource_id: body.id ?? 'all',
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[notifications POST]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
