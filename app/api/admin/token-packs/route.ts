/**
 * Admin token packs API — /api/admin/token-packs
 *
 * GET    — list all token packs
 * POST   — create/update/delete token packs
 *
 * Only accessible by admin user.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for POST /api/admin/token-packs body */
const tokenPacksPostSchema = z
  .object({
    action: z.string(),
  })
  .passthrough();

/** Row shape from token_packs table. */
interface TokenPackRow {
  id: string;
  name_da: string;
  name_en: string;
  token_amount: number;
  price_dkk: number;
  stripe_price_id: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
}

/**
 * Inserts a row into audit_log using the admin client.
 * Fire-and-forget — never throws, never blocks the main operation.
 *
 * @param admin  - Admin Supabase client
 * @param entry  - Audit log entry fields
 */
async function insertAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  entry: { action: string; resource_type: string; resource_id: string; metadata: string }
): Promise<void> {
  try {
    await admin.from('audit_log').insert(entry);
  } catch (e: unknown) {
    logger.error('[audit] Failed to insert audit log:', e);
  }
}

/** Verify caller is admin (app_metadata.isAdmin). */
async function verifyAdmin() {
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

/**
 * GET /api/admin/token-packs — list all token packs.
 */
export async function GET(): Promise<NextResponse> {
  try {
    if (!(await verifyAdmin())) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const admin = createAdminClient();
    const { data, error } = (await admin
      .from('token_packs')
      .select('*')
      .order('sort_order', { ascending: true })) as {
      data: TokenPackRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      logger.error('[admin/token-packs GET] DB error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Map snake_case DB columns to camelCase for the frontend
    const mapped = (data ?? []).map((row) => ({
      id: row.id,
      nameDa: row.name_da,
      nameEn: row.name_en,
      tokens: row.token_amount,
      priceDkk: row.price_dkk,
      stripePriceId: row.stripe_price_id ?? '',
      active: row.is_active,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
    }));

    return NextResponse.json(mapped);
  } catch (err) {
    logger.error('[admin/token-packs] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/token-packs — create, update, or delete a token pack.
 *
 * Body: { action: 'create' | 'update' | 'delete', ...packData }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!(await verifyAdmin())) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Validate request body with Zod schema
    const parsed = await parseBody(req, tokenPacksPostSchema);
    if (!parsed.success) return parsed.response;

    const { action, ...data } = parsed.data;
    const admin = createAdminClient();

    switch (action) {
      case 'create': {
        const { error } = await admin.from('token_packs').insert({
          name_da: data.nameDa,
          name_en: data.nameEn,
          token_amount: data.tokenAmount,
          price_dkk: data.priceDkk,
          stripe_price_id: data.stripePriceId ?? null,
          is_active: data.isActive ?? true,
          sort_order: data.sortOrder ?? 0,
        } as never);
        if (error) {
          logger.error('[admin/token-packs create] DB error:', error.message);
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        }
        // Audit log — fire-and-forget (ISO 27001 A.12.4)
        insertAuditLog(admin, {
          action: 'admin.token_pack.create',
          resource_type: 'token_pack',
          resource_id: String(data.nameDa ?? 'unknown'),
          metadata: JSON.stringify({ data }),
        }).catch(() => {});
        return NextResponse.json({ ok: true });
      }

      case 'update': {
        if (!data.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
        const updates: Record<string, unknown> = {};
        if (data.nameDa !== undefined) updates.name_da = data.nameDa;
        if (data.nameEn !== undefined) updates.name_en = data.nameEn;
        if (data.tokenAmount !== undefined) updates.token_amount = data.tokenAmount;
        if (data.priceDkk !== undefined) updates.price_dkk = data.priceDkk;
        if (data.stripePriceId !== undefined) updates.stripe_price_id = data.stripePriceId;
        if (data.isActive !== undefined) updates.is_active = data.isActive;
        if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;

        const { error } = await admin
          .from('token_packs')
          .update(updates as never)
          .eq('id', data.id);
        if (error) {
          logger.error('[admin/token-packs update] DB error:', error.message);
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        }
        // Audit log — fire-and-forget (ISO 27001 A.12.4)
        insertAuditLog(admin, {
          action: 'admin.token_pack.update',
          resource_type: 'token_pack',
          resource_id: String(data.id),
          metadata: JSON.stringify({ updatedFields: Object.keys(updates) }),
        }).catch(() => {});
        return NextResponse.json({ ok: true });
      }

      case 'delete': {
        if (!data.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
        const { error } = await admin.from('token_packs').delete().eq('id', data.id);
        if (error) {
          logger.error('[admin/token-packs delete] DB error:', error.message);
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        }
        // Audit log — fire-and-forget (ISO 27001 A.12.4)
        insertAuditLog(admin, {
          action: 'admin.token_pack.delete',
          resource_type: 'token_pack',
          resource_id: String(data.id),
          metadata: JSON.stringify({}),
        }).catch(() => {});
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (err) {
    logger.error('[admin/token-packs] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
