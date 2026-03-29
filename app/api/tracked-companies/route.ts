/**
 * Tracked Companies API — /api/tracked-companies
 *
 * Handles CRUD for tracked/monitored companies via Supabase saved_entities
 * with entity_type='company' and is_monitored=true.
 *
 * GET    /api/tracked-companies                     — list tracked companies
 * POST   /api/tracked-companies { entity_id, ... }  — start tracking
 * DELETE /api/tracked-companies?id=<cvr>             — stop tracking
 *
 * @module api/tracked-companies
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getTenantContext } from '@/lib/db/tenant';

/**
 * GET /api/tracked-companies
 *
 * Returns all tracked companies (saved_entities with entity_type='company', is_monitored=true).
 */
export async function GET() {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ tracked: [] });
  }

  try {
    const ctx = await getTenantContext(auth.tenantId);
    const entities = await ctx.savedEntities.list({
      entity_type: 'company',
      monitored_only: true,
    });
    return NextResponse.json({ tracked: entities });
  } catch (err) {
    console.error('[tracked-companies GET]', err);
    return NextResponse.json({ tracked: [] });
  }
}

/**
 * POST /api/tracked-companies
 *
 * Start tracking a company. Upserts a saved_entity with is_monitored=true.
 *
 * Body: { entity_id (CVR), label (company name), entity_data? }
 */
export async function POST(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke logget ind' }, { status: 401 });
  }

  try {
    const ctx = await getTenantContext(auth.tenantId);
    const body = await request.json();

    if (!body?.entity_id) {
      return NextResponse.json({ error: 'Mangler entity_id (CVR)' }, { status: 400 });
    }

    const entity = await ctx.savedEntities.upsert({
      entity_type: 'company',
      entity_id: String(body.entity_id),
      entity_data: body.entity_data ?? {},
      is_monitored: true,
      label: body.label ?? null,
      created_by: auth.userId,
    });

    await ctx.auditLog.write({
      action: 'company.tracked',
      resource_type: 'saved_entity',
      resource_id: entity.id,
      metadata: { entity_id: body.entity_id },
    });

    return NextResponse.json({ entity });
  } catch (err) {
    console.error('[tracked-companies POST]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

/**
 * DELETE /api/tracked-companies?id=<cvr>
 *
 * Stop tracking — sets is_monitored=false (keeps the saved_entity).
 */
export async function DELETE(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke logget ind' }, { status: 401 });
  }

  try {
    const ctx = await getTenantContext(auth.tenantId);
    const entityId = new URL(request.url).searchParams.get('id');

    if (!entityId) {
      return NextResponse.json({ error: 'Mangler id parameter' }, { status: 400 });
    }

    const entities = await ctx.savedEntities.list({
      entity_type: 'company',
      monitored_only: true,
    });
    const match = entities.find((e) => e.entity_id === entityId);

    if (match) {
      await ctx.savedEntities.upsert({
        entity_type: 'company',
        entity_id: entityId,
        entity_data: match.entity_data as Record<string, unknown>,
        is_monitored: false,
        label: match.label,
        created_by: match.created_by,
      });

      await ctx.auditLog.write({
        action: 'company.untracked',
        resource_type: 'saved_entity',
        resource_id: match.id,
        metadata: { entity_id: entityId },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[tracked-companies DELETE]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
