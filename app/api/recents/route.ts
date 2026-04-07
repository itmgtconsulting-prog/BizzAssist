/**
 * Recent Entities API — /api/recents
 *
 * Stores and retrieves recently viewed entities (properties, companies, people, searches).
 * Data is stored in public.recent_entities, scoped per user and tenant via RLS.
 *
 * GET    /api/recents?type=property       — list recent entities for the current user
 * POST   /api/recents { entity_type, ... } — upsert a recent visit
 * DELETE /api/recents?type=property        — clear recents for a type
 *
 * @module api/recents
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

/** Max recent entities per type per user */
const MAX_RECENTS: Record<string, number> = {
  property: 6,
  company: 8,
  person: 6,
  search: 10,
};

/** Table lives in public schema — accessible via Supabase REST API */
const TABLE = 'recent_entities';

/**
 * GET /api/recents?type=property
 *
 * Returns recent entities for the authenticated user, sorted by most recent.
 */
export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const entityType = new URL(request.url).searchParams.get('type') ?? 'property';
    const admin = createAdminClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin.from(TABLE) as any)
      .select('*')
      .eq('tenant_id', auth.tenantId)
      .eq('user_id', auth.userId)
      .eq('entity_type', entityType)
      .order('visited_at', { ascending: false })
      .limit(MAX_RECENTS[entityType] ?? 6);

    if (error) {
      console.error('[recents GET]', error);
      return NextResponse.json({ recents: [] });
    }

    return NextResponse.json({ recents: data ?? [] });
  } catch (err) {
    console.error('[recents GET]', err);
    return NextResponse.json({ recents: [] });
  }
}

/**
 * POST /api/recents
 *
 * Upserts a recently viewed entity. Automatically prunes old entries
 * beyond the max limit.
 *
 * Body: { entity_type, entity_id, display_name, entity_data? }
 */
export async function POST(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke logget ind' }, { status: 401 });
  }

  try {
    const body = await request.json();
    if (!body?.entity_type || !body?.entity_id || !body?.display_name) {
      return NextResponse.json({ error: 'Mangler påkrævede felter' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Upsert: update visited_at if already exists, insert if new
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upsertError } = await (admin.from(TABLE) as any).upsert(
      {
        tenant_id: auth.tenantId,
        user_id: auth.userId,
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        display_name: body.display_name,
        entity_data: body.entity_data ?? {},
        visited_at: new Date().toISOString(),
      },
      {
        onConflict: 'tenant_id,user_id,entity_type,entity_id',
      }
    );

    if (upsertError) {
      console.error('[recents POST] upsert error:', upsertError);
      return NextResponse.json({ error: 'Kunne ikke gemme' }, { status: 500 });
    }

    // Prune: keep only the most recent N entries for this type
    const maxItems = MAX_RECENTS[body.entity_type] ?? 6;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: allRecents } = await (admin.from(TABLE) as any)
      .select('id, visited_at')
      .eq('tenant_id', auth.tenantId)
      .eq('user_id', auth.userId)
      .eq('entity_type', body.entity_type)
      .order('visited_at', { ascending: false });

    if (allRecents && allRecents.length > maxItems) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const idsToDelete = allRecents.slice(maxItems).map((r: any) => r.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin.from(TABLE) as any).delete().in('id', idsToDelete);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[recents POST]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

/**
 * DELETE /api/recents?type=property
 *
 * Clears all recent entities of a given type for the current user.
 */
export async function DELETE(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke logget ind' }, { status: 401 });
  }

  try {
    const entityType = new URL(request.url).searchParams.get('type');
    if (!entityType) {
      return NextResponse.json({ error: 'Mangler type parameter' }, { status: 400 });
    }

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin.from(TABLE) as any)
      .delete()
      .eq('tenant_id', auth.tenantId)
      .eq('user_id', auth.userId)
      .eq('entity_type', entityType);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[recents DELETE]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
