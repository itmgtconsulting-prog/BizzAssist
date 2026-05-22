/**
 * GET/PATCH/DELETE /api/vurderingsrapport/sager/[sagId]
 *
 * BIZZ-1640: Sag-detalje CRUD for vurderingsrapport.
 * GET    — hent sag med upload-zoner, dokumenter og rapport-tabs
 * PATCH  — opdater sag-felter (status, tone, beskrivelse)
 * DELETE — slet sag + cascade (zoner, dokumenter, tabs)
 *
 * @module api/vurderingsrapport/sager/[sagId]
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

/** PATCH body schema */
const updateSagSchema = z
  .object({
    status: z.enum(['oprettet', 'dataindsamling', 'rapport_genereret', 'afsluttet']).optional(),
    rapport_tone: z.enum(['realkredit', 'bankraadgiver', 'memo']).optional(),
    beskrivelse: z.string().optional(),
    ejendom_bfe: z.number().optional(),
    ejendom_adresse: z.string().optional(),
    ejendom_dawa_id: z.string().optional(),
  })
  .partial();

/**
 * GET /api/vurderingsrapport/sager/[sagId]
 *
 * @returns { sag, zoner, dokumenter, tabs }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sagId: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sagId } = await params;

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    const [sagResult, zonerResult, docsResult, tabsResult] = await Promise.all([
      db
        .from('vurdering_sager')
        .select('*')
        .eq('id', sagId)
        .eq('tenant_id', auth.tenantId)
        .maybeSingle(),
      db
        .from('vurdering_upload_zoner')
        .select('*')
        .eq('sag_id', sagId)
        .eq('tenant_id', auth.tenantId),
      db
        .from('vurdering_dokumenter')
        .select('*')
        .eq('sag_id', sagId)
        .eq('tenant_id', auth.tenantId)
        .order('created_at'),
      db
        .from('vurdering_rapport_tabs')
        .select('*')
        .eq('sag_id', sagId)
        .eq('tenant_id', auth.tenantId)
        .order('tab_key'),
    ]);

    if (!sagResult.data) {
      return NextResponse.json({ error: 'Sag ikke fundet' }, { status: 404 });
    }

    return NextResponse.json({
      sag: sagResult.data,
      zoner: zonerResult.data ?? [],
      dokumenter: docsResult.data ?? [],
      tabs: tabsResult.data ?? [],
    });
  } catch (err) {
    logger.error('[vurderingsrapport/sager/[sagId] GET]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

/**
 * PATCH /api/vurderingsrapport/sager/[sagId]
 *
 * @returns { sag: updated }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sagId: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sagId } = await params;

  let body: z.infer<typeof updateSagSchema>;
  try {
    body = updateSagSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Ugyldigt input' }, { status: 400 });
  }

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .schema(schemaName)
      .from('vurdering_sager')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', sagId)
      .eq('tenant_id', auth.tenantId)
      .select()
      .single();

    if (error) {
      logger.error('[vurderingsrapport/sager PATCH] DB:', error.message);
      return NextResponse.json({ error: 'Kunne ikke opdatere' }, { status: 500 });
    }

    return NextResponse.json({ sag: data });
  } catch (err) {
    logger.error('[vurderingsrapport/sager PATCH]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

/**
 * DELETE /api/vurderingsrapport/sager/[sagId]
 *
 * @returns { ok: true }
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sagId: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sagId } = await params;

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any)
      .schema(schemaName)
      .from('vurdering_sager')
      .delete()
      .eq('id', sagId)
      .eq('tenant_id', auth.tenantId);

    if (error) {
      logger.error('[vurderingsrapport/sager DELETE] DB:', error.message);
      return NextResponse.json({ error: 'Kunne ikke slette' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[vurderingsrapport/sager DELETE]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
