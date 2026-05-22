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
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { writeAuditLog } from '@/app/lib/auditLog';

/** Zod schema for POST /api/recents body */
const RecentsPostSchema = z.object({
  entity_type: z.enum(['property', 'company', 'person', 'search']),
  entity_id: z.string().min(1),
  display_name: z.string().min(1),
  entity_data: z.record(z.string(), z.unknown()).optional(),
});

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
 * BIZZ-1626: Dedup person-recents. Samme fysiske person kan have flere
 * enhedsNummer i CVR ES — behold kun den seneste visit per person.
 *
 * Dedup-logik (kræver navnematch + mindst ét sekundært signal):
 *   1. display_name matcher (case-insensitive)
 *   2. PLUS mindst ét af:
 *      a) Deler mindst ét CVR i entity_data.virksomheder
 *      b) Samme adresse i entity_data.adresse
 *      c) Ingen virksomheder/adresse at sammenligne (legacy data)
 *
 * To "Hans Hansen" med forskellige virksomheder OG forskellige adresser
 * beholdes begge — undgår at slå to fysisk forskellige personer sammen.
 *
 * Rows er allerede sorteret visited_at DESC — første forekomst vinder.
 */
function dedupPersonRecents(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  interface PersonFingerprint {
    cvrs: Set<string>;
    adresse: string;
  }
  const seen = new Map<string, PersonFingerprint>();

  return rows.filter((r) => {
    if (r.entity_type !== 'person') return true;
    const name = ((r.display_name as string) ?? '').toLowerCase().trim();
    if (!name) return true;

    const ed = r.entity_data as Record<string, unknown> | undefined;
    // Virksomheder kan gemmes som JSON-streng (ny) eller array (fremtidig)
    let virksomheder: string[] = [];
    if (typeof ed?.virksomheder === 'string') {
      try {
        virksomheder = (JSON.parse(ed.virksomheder) as Array<{ cvr?: string }>)
          .map((v) => v.cvr ?? '')
          .filter(Boolean);
      } catch {
        /* ignore */
      }
    } else if (Array.isArray(ed?.virksomheder)) {
      virksomheder = (ed!.virksomheder as Array<{ cvr?: string }>)
        .map((v) => v.cvr ?? '')
        .filter(Boolean);
    }
    const adresse = ((ed?.adresse as string) ?? '').toLowerCase().trim();

    const existing = seen.get(name);
    if (!existing) {
      seen.set(name, { cvrs: new Set(virksomheder), adresse });
      return true;
    }

    // BIZZ-1626 fix: entries uden virksomheder-array OG uden adresse
    // dedupes på display_name alene — legacy entity_data har kun
    // antalVirksomheder/erVirksomhed men ikke virksomheder[]/adresse.
    const currentHasNoData = virksomheder.length === 0 && !adresse;
    const existingHasNoData = existing.cvrs.size === 0 && !existing.adresse;
    const noDataToCompare = currentHasNoData || existingHasNoData;

    // Samme navn — tjek om det er samme fysiske person
    const cvrOverlap = virksomheder.some((cvr) => existing.cvrs.has(cvr));
    const adresseMatch =
      adresse.length > 3 && existing.adresse.length > 3 && adresse === existing.adresse;

    if (!cvrOverlap && !adresseMatch && !noDataToCompare) {
      // Forskellige person — behold begge
      return true;
    }

    // Samme person — merge data og skip denne (ældre) entry
    for (const cvr of virksomheder) existing.cvrs.add(cvr);
    if (!existing.adresse && adresse) existing.adresse = adresse;
    return false;
  });
}

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
    const entityType = (new URL(request.url).searchParams.get('type') ?? 'property') as
      | 'company'
      | 'property'
      | 'person'
      | 'search'
      | 'all';
    const admin = createAdminClient();

    // BIZZ-1582: type=all returns all types in a single query (saves 3 round-trips
    // from RecentEntityTagBar which previously fired 4 parallel requests).
    if (entityType === 'all') {
      const { data, error } = await admin
        .from(TABLE)
        .select('*')
        .eq('tenant_id', auth.tenantId)
        .eq('user_id', auth.userId)
        .in('entity_type', ['property', 'company', 'person', 'search'])
        .order('visited_at', { ascending: false })
        .limit(30);

      if (error) {
        logger.error('[recents GET] DB error:', error);
        return NextResponse.json(
          { error: 'Databasefejl ved hentning af seneste' },
          { status: 500 }
        );
      }
      return NextResponse.json({ recents: dedupPersonRecents(data ?? []) });
    }

    const { data, error } = await admin
      .from(TABLE)
      .select('*')
      .eq('tenant_id', auth.tenantId)
      .eq('user_id', auth.userId)
      .eq('entity_type', entityType)
      .order('visited_at', { ascending: false })
      .limit(MAX_RECENTS[entityType] ?? 6);

    if (error) {
      logger.error('[recents GET] DB error:', error);
      return NextResponse.json({ error: 'Databasefejl ved hentning af seneste' }, { status: 500 });
    }

    return NextResponse.json({ recents: dedupPersonRecents(data ?? []) });
  } catch (err) {
    logger.error('[recents GET] Unexpected error:', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
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
    const parsed = RecentsPostSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ugyldigt input' }, { status: 400 });
    }
    const body = parsed.data;

    const admin = createAdminClient();

    // Upsert: update visited_at if already exists, insert if new
    const { error: upsertError } = await admin.from(TABLE).upsert(
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
      logger.error('[recents POST] upsert error:', upsertError);
      return NextResponse.json({ error: 'Kunne ikke gemme' }, { status: 500 });
    }

    // Prune: keep only the most recent N entries for this type
    const maxItems = MAX_RECENTS[body.entity_type] ?? 6;
    const { data: allRecents } = await admin
      .from(TABLE)
      .select('id, visited_at')
      .eq('tenant_id', auth.tenantId)
      .eq('user_id', auth.userId)
      .eq('entity_type', body.entity_type)
      .order('visited_at', { ascending: false });

    if (allRecents && allRecents.length > maxItems) {
      const idsToDelete = allRecents.slice(maxItems).map((r) => r.id);
      await admin.from(TABLE).delete().in('id', idsToDelete);
    }

    // BIZZ-289: Audit log for recent entity tracking
    writeAuditLog({
      action: 'recent_entity.upsert',
      resource_type: body.entity_type,
      resource_id: body.entity_id ?? 'unknown',
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[recents POST]', err);
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
    const entityTypeRaw = new URL(request.url).searchParams.get('type');
    if (!entityTypeRaw) {
      return NextResponse.json({ error: 'Mangler type parameter' }, { status: 400 });
    }
    const entityType = entityTypeRaw as 'company' | 'property' | 'person' | 'search';

    const admin = createAdminClient();
    await admin
      .from(TABLE)
      .delete()
      .eq('tenant_id', auth.tenantId)
      .eq('user_id', auth.userId)
      .eq('entity_type', entityType);

    writeAuditLog({
      action: 'recent_entity.delete',
      resource_type: entityType,
      resource_id: 'all',
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[recents DELETE]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
