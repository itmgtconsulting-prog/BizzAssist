/**
 * GET/POST /api/vurderingsrapport/sager
 *
 * BIZZ-1640: CRUD for vurderingsrapport-sager.
 * GET  — list sager for tenant
 * POST — opret ny sag med auto-genereret sagsnummer (VR-0001)
 *
 * @module api/vurderingsrapport/sager
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

/** Zod schema for POST body */
const createSagSchema = z.object({
  kunde_type: z.enum(['virksomhed', 'person']),
  kunde_id: z.string().min(1),
  kunde_navn: z.string().optional(),
  ejendom_bfe: z.number().optional(),
  ejendom_adresse: z.string().optional(),
  ejendom_dawa_id: z.string().optional(),
  rapport_tone: z.enum(['realkredit', 'bankraadgiver', 'memo']).default('realkredit'),
  beskrivelse: z.string().optional(),
});

/**
 * GET /api/vurderingsrapport/sager
 *
 * @returns { sager: VurderingSag[] }
 */
export async function GET(): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .schema(schemaName)
      .from('vurdering_sager')
      .select('*')
      .eq('tenant_id', auth.tenantId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[vurderingsrapport/sager GET] DB:', error.message);
      return NextResponse.json({ error: 'Databasefejl' }, { status: 500 });
    }

    return NextResponse.json({ sager: data ?? [] });
  } catch (err) {
    logger.error('[vurderingsrapport/sager GET]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

/**
 * POST /api/vurderingsrapport/sager
 *
 * @returns { sag: VurderingSag }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof createSagSchema>;
  try {
    body = createSagSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Ugyldigt input' }, { status: 400 });
  }

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Auto-generér sagsnummer: VR-0001, VR-0002...
    const { count } = await db
      .from('vurdering_sager')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', auth.tenantId);
    const nextNum = (count ?? 0) + 1;
    const sagNummer = `VR-${String(nextNum).padStart(4, '0')}`;

    const { data, error } = await db
      .from('vurdering_sager')
      .insert({
        tenant_id: auth.tenantId,
        sag_nummer: sagNummer,
        kunde_type: body.kunde_type,
        kunde_id: body.kunde_id,
        kunde_navn: body.kunde_navn ?? null,
        ejendom_bfe: body.ejendom_bfe ?? null,
        ejendom_adresse: body.ejendom_adresse ?? null,
        ejendom_dawa_id: body.ejendom_dawa_id ?? null,
        rapport_tone: body.rapport_tone,
        beskrivelse: body.beskrivelse ?? null,
        created_by: auth.userId,
      })
      .select()
      .single();

    if (error) {
      logger.error('[vurderingsrapport/sager POST] DB:', error.message);
      return NextResponse.json({ error: 'Kunne ikke oprette sag' }, { status: 500 });
    }

    return NextResponse.json({ sag: data }, { status: 201 });
  } catch (err) {
    logger.error('[vurderingsrapport/sager POST]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
