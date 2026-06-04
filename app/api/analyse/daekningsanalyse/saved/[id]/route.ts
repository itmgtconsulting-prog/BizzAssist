/**
 * Single saved analysis — GET /api/analyse/daekningsanalyse/saved/[id]
 *
 * BIZZ-2001: Returns full analysis data including results JSON.
 *
 * @module app/api/analyse/daekningsanalyse/saved/[id]/route
 */

import { NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireModuleAccess } from '@/app/lib/serverModuleAccess';
import { logger } from '@/app/lib/logger';

/**
 * GET /api/analyse/daekningsanalyse/saved/[id]
 *
 * @returns Full saved analysis with results
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const blocked = await requireModuleAccess('daekningsanalyse');
  if (blocked) return blocked;

  const tenant = await resolveTenantId();
  if (!tenant?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('daekningsanalyse_saved')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.tenantId)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (err) {
    logger.error('[daekningsanalyse/saved/id] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
