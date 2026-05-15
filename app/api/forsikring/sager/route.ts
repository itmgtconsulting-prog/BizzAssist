/**
 * GET /api/forsikring/sager — List alle kundesager for tenant.
 * POST /api/forsikring/sager — Opret eller find eksisterende sag.
 *
 * BIZZ-1384: Kundesag-model — samler policer, analyser og noter per kunde.
 *
 * @module api/forsikring/sager
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

/**
 * GET /api/forsikring/sager — List alle sager for tenant.
 *
 * @returns { sager: Array<Sag> }
 */
export async function GET(): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Hent sager med antal policer + analyser
    const { data: sager, error } = await db
      .from('forsikring_sager')
      .select('*')
      .eq('tenant_id', auth.tenantId)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) {
      logger.error('[forsikring/sager GET]', error.message);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    // Berig med police-count og analyse-count per sag
    const sagIds = (sager ?? []).map((s: { id: string }) => s.id);
    const policeCounts = new Map<string, number>();
    const analyseCounts = new Map<string, number>();

    if (sagIds.length > 0) {
      const { data: polRows } = await db
        .from('forsikring_policies')
        .select('sag_id')
        .in('sag_id', sagIds);
      for (const r of (polRows ?? []) as Array<{ sag_id: string }>) {
        policeCounts.set(r.sag_id, (policeCounts.get(r.sag_id) ?? 0) + 1);
      }

      const { data: anaRows } = await db
        .from('forsikring_analyser')
        .select('id, kunde_id')
        .eq('tenant_id', auth.tenantId);
      // Match analyser til sager via kunde_id
      for (const sag of (sager ?? []) as Array<{ id: string; kunde_id: string }>) {
        const count = (anaRows ?? []).filter(
          (a: { kunde_id: string }) => a.kunde_id === sag.kunde_id
        ).length;
        if (count > 0) analyseCounts.set(sag.id, count);
      }
    }

    const enriched = (sager ?? []).map((s: Record<string, unknown>) => ({
      ...s,
      police_count: policeCounts.get(s.id as string) ?? 0,
      analyse_count: analyseCounts.get(s.id as string) ?? 0,
    }));

    return NextResponse.json({ sager: enriched });
  } catch (err) {
    logger.error('[forsikring/sager GET]', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

/**
 * POST /api/forsikring/sager — Opret eller find eksisterende sag.
 *
 * Body: { kunde_type, kunde_id, kunde_navn? }
 * Returnerer eksisterende sag hvis den allerede findes (upsert).
 *
 * @param request - Next.js request
 * @returns { sag: Sag, created: boolean }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { kunde_type: string; kunde_id: string; kunde_navn?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { kunde_type, kunde_id, kunde_navn } = body;
  if (!kunde_type || !kunde_id || !['virksomhed', 'person'].includes(kunde_type)) {
    return NextResponse.json({ error: 'Missing kunde_type/kunde_id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Tjek om sag allerede eksisterer
    const { data: existing } = await db
      .from('forsikring_sager')
      .select('*')
      .eq('tenant_id', auth.tenantId)
      .eq('kunde_type', kunde_type)
      .eq('kunde_id', kunde_id)
      .maybeSingle();

    if (existing) {
      // Opdater navn hvis ændret
      if (kunde_navn && kunde_navn !== existing.kunde_navn) {
        await db
          .from('forsikring_sager')
          .update({ kunde_navn, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
      }
      return NextResponse.json({ sag: existing, created: false });
    }

    // Opret ny sag
    const { data: sag, error } = await db
      .from('forsikring_sager')
      .insert({
        tenant_id: auth.tenantId,
        kunde_type,
        kunde_id,
        kunde_navn: kunde_navn ?? null,
        ansvarlig: auth.userId,
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[forsikring/sager POST]', error.message);
      return NextResponse.json({ error: 'Kunne ikke oprette sag' }, { status: 500 });
    }

    return NextResponse.json({ sag, created: true }, { status: 201 });
  } catch (err) {
    logger.error('[forsikring/sager POST]', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
