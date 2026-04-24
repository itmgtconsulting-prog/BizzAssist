/**
 * GET  /api/admin/config         — returnér alle system_config rows
 *   Optional query: ?category=endpoints
 * PATCH /api/admin/config         — opdater én værdi
 *   Body: { key: string, value: unknown, description?: string, category?: string }
 *
 * BIZZ-419: Admin-facing konfigurationspanel der lader super-admin
 * ændre hardcoded værdier (endpoints, emails, rate-limits osv.) uden
 * redeploy. Alle ændringer logges i audit_log.
 *
 * Auth: app_metadata.isAdmin=true påkrævet — samme pattern som
 * /api/admin/ai-settings og /api/admin/plans.
 *
 * @module app/api/admin/config
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { writeAuditLog } from '@/app/lib/auditLog';
import { invalidateConfig, type SystemConfigRow } from '@/app/lib/systemConfig';

/**
 * PATCH body schema. value er "unknown" fordi vi tillader string/number/
 * boolean/object/array i JSONB — client må sende hvad der giver mening
 * for den specifikke key.
 */
const patchSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(100)
    // Håndhæv snake_case så vi undgår inkonsistent naming i config-store
    .regex(/^[a-z][a-z0-9_]*$/, 'key skal være snake_case'),
  value: z.unknown(),
  description: z.string().max(500).optional(),
  category: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/, 'category skal være snake_case')
    .optional(),
});

/**
 * Resolve authenticated user and verify admin role via fresh
 * app_metadata — same defense-in-depth pattern as other admin routes.
 */
async function requireAdmin(): Promise<{ userId: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (freshUser?.user?.app_metadata?.isAdmin) return { userId: user.id };
  return null;
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
  }

  const category = req.nextUrl.searchParams.get('category');
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = (admin as any)
      .from('system_config')
      .select('id, category, key, value, description, updated_at, updated_by')
      .order('category', { ascending: true })
      .order('key', { ascending: true });
    if (category) q = q.eq('category', category);
    const { data, error } = (await q) as {
      data: SystemConfigRow[] | null;
      error: { message: string } | null;
    };
    if (error) {
      logger.error('[admin/config GET] db error:', error.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }
    return NextResponse.json({ configs: data ?? [] });
  } catch (err) {
    logger.error('[admin/config GET] exception:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Input-fejl', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { key, value, description, category } = parsed.data;

  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = (await (admin as any)
      .from('system_config')
      .select('id, value, category')
      .eq('key', key)
      .maybeSingle()) as { data: { id: string; value: unknown; category: string } | null };

    if (existing) {
      // Eksisterende row — opdater value + evt. description/category.
      const updateFields: Record<string, unknown> = {
        value,
        updated_by: session.userId,
      };
      if (description !== undefined) updateFields.description = description;
      if (category !== undefined) updateFields.category = category;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any)
        .from('system_config')
        .update(updateFields)
        .eq('id', existing.id);
      if (error) {
        logger.error('[admin/config PATCH] update error:', error.message);
        return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
      }
    } else {
      // Ny row — kræv category så det ikke ender i 'uncategorized'.
      if (!category) {
        return NextResponse.json(
          { error: 'category kræves ved oprettelse af ny key' },
          { status: 400 }
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any).from('system_config').insert({
        key,
        value,
        description: description ?? null,
        category,
        updated_by: session.userId,
      });
      if (error) {
        logger.error('[admin/config PATCH] insert error:', error.message);
        return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
      }
    }

    // Invalidér proces-lokal cache så efterfølgende reads på samme instans
    // ser den nye værdi med det samme. Andre instanser får den næste gang
    // deres 5-min cache udløber.
    invalidateConfig(key);

    // Audit log — fire-and-forget
    void writeAuditLog({
      action: 'system_config.update',
      resource_type: 'system_config',
      resource_id: key,
      metadata: JSON.stringify({
        previousValue: existing?.value ?? null,
        newValue: value,
        category: category ?? existing?.category ?? null,
      }),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[admin/config PATCH] exception:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
