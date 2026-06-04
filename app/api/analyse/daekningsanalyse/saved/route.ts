/**
 * Saved coverage analyses CRUD — /api/analyse/daekningsanalyse/saved
 *
 * BIZZ-2001: GET = list saved analyses, POST = save new analysis.
 * BIZZ-2002: RLS ensures tenant-scoped sharing.
 *
 * @module app/api/analyse/daekningsanalyse/saved/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireModuleAccess } from '@/app/lib/serverModuleAccess';
import { parseBody } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';

const saveSchema = z.object({
  name: z.string().min(1).max(200),
  thresholds: z.object({ redMax: z.number(), greenMin: z.number() }),
  results: z.array(z.record(z.string(), z.unknown())),
  fileName: z.string().max(500).optional(),
  originalAddresses: z.array(z.string()).optional(),
});

/**
 * GET /api/analyse/daekningsanalyse/saved — list saved analyses for current tenant.
 *
 * @returns JSON array of saved analyses (without full results, for performance)
 */
export async function GET(): Promise<NextResponse | Response> {
  const blocked = await requireModuleAccess('daekningsanalyse');
  if (blocked) return blocked;

  const tenant = await resolveTenantId();
  if (!tenant?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('daekningsanalyse_saved')
      .select('id, name, matrikel_count, kunde_count, total_count, created_at, user_id, file_name')
      .eq('tenant_id', tenant.tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      logger.error('[daekningsanalyse/saved] List error:', error.message);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }

    return NextResponse.json(data ?? []);
  } catch (err) {
    logger.error('[daekningsanalyse/saved] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

/**
 * POST /api/analyse/daekningsanalyse/saved — save a new analysis.
 *
 * @param req - JSON body with name, thresholds, results, fileName
 * @returns JSON with { id } of the saved analysis
 */
export async function POST(req: NextRequest): Promise<NextResponse | Response> {
  const blocked = await requireModuleAccess('daekningsanalyse');
  if (blocked) return blocked;

  const tenant = await resolveTenantId();
  if (!tenant?.tenantId || !tenant.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = await parseBody(req, saveSchema);
  if (!parsed.success) return parsed.response;
  const { name, thresholds, results, fileName } = parsed.data;

  try {
    const admin = createAdminClient();

    const matrikelCount = results.length;
    const kundeCount = results.reduce(
      (s, r) => s + ((r as { kundeAntal?: number }).kundeAntal ?? 0),
      0
    );
    const totalCount = results.reduce(
      (s, r) => s + ((r as { totalEnheder?: number }).totalEnheder ?? 0),
      0
    );

    const { data, error } = (await (
      admin.from('daekningsanalyse_saved') as ReturnType<typeof admin.from>
    )
      .insert({
        tenant_id: tenant.tenantId,
        user_id: tenant.userId,
        name,
        thresholds,
        results: results as unknown,
        file_name: fileName ?? null,
        matrikel_count: matrikelCount,
        kunde_count: kundeCount,
        total_count: totalCount,
      } as Record<string, unknown>)
      .select('id')
      .single()) as { data: { id: string } | null; error: { message: string } | null };

    if (error) {
      logger.error('[daekningsanalyse/saved] Insert error:', error.message);
      return NextResponse.json({ error: 'Could not save' }, { status: 500 });
    }

    return NextResponse.json({ id: data?.id });
  } catch (err) {
    logger.error('[daekningsanalyse/saved] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
