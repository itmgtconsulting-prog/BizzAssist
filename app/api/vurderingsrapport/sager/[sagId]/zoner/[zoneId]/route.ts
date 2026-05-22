/**
 * PATCH /api/vurderingsrapport/sager/[sagId]/zoner/[zoneId]
 *
 * BIZZ-1684: Opdater fritekst-noter for en upload-zone.
 *
 * @module api/vurderingsrapport/sager/[sagId]/zoner/[zoneId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

/**
 * PATCH handler — opdater fritekst.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sagId: string; zoneId: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { zoneId } = await params;
  let body: { fritekst?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldigt input' }, { status: 400 });
  }

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any)
      .schema(schemaName)
      .from('vurdering_upload_zoner')
      .update({
        fritekst: body.fritekst ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', zoneId)
      .eq('tenant_id', auth.tenantId);

    if (error) {
      logger.error('[zoner PATCH] DB:', error.message);
      return NextResponse.json({ error: 'Kunne ikke opdatere' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[zoner PATCH]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
