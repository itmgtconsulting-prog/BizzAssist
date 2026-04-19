/**
 * Tracked properties API — /api/tracked
 *
 * Håndterer CRUD for fulgte ejendomme via Supabase saved_entities
 * med is_monitored=true. Falder tilbage til tom respons hvis
 * brugeren ikke er logget ind (localStorage-MVP håndterer offline).
 *
 * GET    /api/tracked                     — hent alle fulgte
 * POST   /api/tracked { entity_id, ... }  — start følgning
 * DELETE  /api/tracked?id=<entity_id>     — stop følgning
 *
 * Side-effekter ved POST:
 *   - Henter BBR-data for ejendommen og udfylder public.bbr_tracked_objects
 *     med bygning-UUIDs. Gør det muligt for pull-cronen og push-webhook at
 *     matche Datafordeler BBR-hændelser direkte mod fulgte ejendomme.
 *
 * Side-effekter ved DELETE:
 *   - Fjerner alle rækker i public.bbr_tracked_objects for (tenant_id, bfe_nummer).
 *
 * @module api/tracked
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { getTenantContext } from '@/lib/db/tenant';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { logger } from '@/app/lib/logger';
import { writeAuditLog } from '@/app/lib/auditLog';

/** Zod schema for POST /api/tracked body */
const TrackedPostSchema = z.object({
  entity_id: z.string().min(1),
  label: z.string().nullish(),
  entity_data: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Udfylder public.bbr_tracked_objects med BBR bygning-UUIDs for en fulgt ejendom.
 * Kaldes asynkront (fire-and-forget) efter at ejendom er tilføjet til watched list.
 *
 * @param tenantId - Tenant UUID
 * @param dawaId - DAWA adresse-UUID (entity_id i saved_entities)
 */
async function enrichBbrTrackedObjects(tenantId: string, dawaId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const bbrData = await fetchBbrForAddress(dawaId);

    const bfeNummer =
      bbrData.ejendomsrelationer?.[0]?.bfeNummer?.toString() ??
      bbrData.ejerlejlighedBfe?.toString() ??
      bbrData.moderBfe?.toString() ??
      null;

    if (!bfeNummer) return; // Ingen BFE-nummer — kan ikke indeksere

    const rows: {
      tenant_id: string;
      bfe_nummer: string;
      bbr_object_id: string;
      bbr_object_type: 'Bygning' | 'Grund' | 'Enhed' | 'Etage' | 'OpgangDørenhed';
    }[] = [];

    // Indeksér alle bygning-UUIDs
    for (const bygning of bbrData.bbr ?? []) {
      if (bygning.id) {
        rows.push({
          tenant_id: tenantId,
          bfe_nummer: bfeNummer,
          bbr_object_id: bygning.id,
          bbr_object_type: 'Bygning',
        });
      }
    }

    // BIZZ-489: Indeksér også enheder, opgange og etager så fulgte ejendomme
    // får besked når disse ændrer sig. Schema-constraint tillader Bygning/Grund/
    // Enhed/Etage/OpgangDørenhed (Opgang fra Datafordeler mappes til
    // OpgangDørenhed som er det officielle navn i bbr_tracked_objects-tabellen).
    for (const enhed of bbrData.enheder ?? []) {
      if (enhed.id) {
        rows.push({
          tenant_id: tenantId,
          bfe_nummer: bfeNummer,
          bbr_object_id: enhed.id,
          bbr_object_type: 'Enhed',
        });
      }
    }
    for (const opgang of bbrData.opgange ?? []) {
      if (opgang.id) {
        rows.push({
          tenant_id: tenantId,
          bfe_nummer: bfeNummer,
          bbr_object_id: opgang.id,
          bbr_object_type: 'OpgangDørenhed',
        });
      }
    }
    for (const etage of bbrData.etager ?? []) {
      if (etage.id) {
        rows.push({
          tenant_id: tenantId,
          bfe_nummer: bfeNummer,
          bbr_object_id: etage.id,
          bbr_object_type: 'Etage',
        });
      }
    }

    if (rows.length === 0) return;

    await admin
      .from('bbr_tracked_objects')
      .upsert(rows, { onConflict: 'tenant_id,bfe_nummer,bbr_object_id', ignoreDuplicates: true });
  } catch (err) {
    // Fire-and-forget — log fejl men afbryd ikke tracking-svaret
    logger.error('[tracked] BBR-indeksering fejlede:', err);
  }
}

/**
 * Fjerner BBR-objekt indeks for en ejendom der holder op med at følges.
 *
 * @param tenantId - Tenant UUID
 * @param bfeNummer - BFE-nummer (fra entity_data hvis tilgængeligt)
 * @param dawaId - DAWA adresse-UUID (fallback til BFE-opslag)
 */
async function cleanupBbrTrackedObjects(
  tenantId: string,
  dawaId: string,
  entityData: Record<string, unknown>
): Promise<void> {
  try {
    const admin = createAdminClient();

    // Forsøg at finde BFE-nummer fra entity_data eller via BBR-opslag
    let bfeNummer = (entityData?.bfeNummer as string | undefined) ?? null;
    if (!bfeNummer) {
      const bbrData = await fetchBbrForAddress(dawaId);
      bfeNummer =
        bbrData.ejendomsrelationer?.[0]?.bfeNummer?.toString() ??
        bbrData.ejerlejlighedBfe?.toString() ??
        null;
    }

    if (!bfeNummer) return;

    await admin
      .from('bbr_tracked_objects')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('bfe_nummer', bfeNummer);
  } catch (err) {
    logger.error('[tracked] BBR-oprydning fejlede:', err);
  }
}

/**
 * Resolver tenant ID fra den autentificerede brugers session.
 * Returnerer null hvis brugeren ikke er logget ind eller ikke har en tenant.
 */
async function resolveTenantId(): Promise<{ tenantId: string; userId: string } | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data } = (await supabase
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1)
      .single()) as { data: { tenant_id: string } | null };
    if (!data?.tenant_id) return null;
    return { tenantId: data.tenant_id, userId: user.id };
  } catch {
    return null;
  }
}

/**
 * GET /api/tracked
 *
 * Returnerer alle fulgte ejendomme (saved_entities med is_monitored=true).
 */
export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ tracked: [] });
  }

  try {
    const ctx = await getTenantContext(auth.tenantId);
    const entities = await ctx.savedEntities.list({
      entity_type: 'property',
      monitored_only: true,
    });
    return NextResponse.json({ tracked: entities });
  } catch (err) {
    logger.error('[tracked GET]', err);
    return NextResponse.json({ tracked: [] });
  }
}

/**
 * POST /api/tracked
 *
 * Start følgning af en ejendom. Upsert'er en saved_entity
 * med is_monitored=true.
 *
 * Body: { entity_id, label, entity_data? }
 */
export async function POST(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke logget ind' }, { status: 401 });
  }

  try {
    const ctx = await getTenantContext(auth.tenantId);
    const parsed = TrackedPostSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ugyldigt input' }, { status: 400 });
    }
    const body = parsed.data;

    const entity = await ctx.savedEntities.upsert({
      entity_type: 'property',
      entity_id: body.entity_id,
      entity_data: body.entity_data ?? {},
      is_monitored: true,
      label: body.label ?? null,
      created_by: auth.userId,
    });

    await ctx.auditLog.write({
      action: 'property.tracked',
      resource_type: 'saved_entity',
      resource_id: entity.id,
      metadata: { entity_id: body.entity_id },
    });

    // Indeksér BBR-objekt UUIDs asynkront — blokkerer ikke svaret
    enrichBbrTrackedObjects(auth.tenantId, body.entity_id).catch(() => {});

    return NextResponse.json({ entity });
  } catch (err) {
    logger.error('[tracked POST]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

/**
 * DELETE /api/tracked?id=<entity_id>
 *
 * Stop følgning — sætter is_monitored=false (beholder saved_entity).
 */
export async function DELETE(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

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

    // Find entity og sæt is_monitored=false
    const entities = await ctx.savedEntities.list({
      entity_type: 'property',
      monitored_only: true,
    });
    const match = entities.find((e) => e.entity_id === entityId);

    if (match) {
      await ctx.savedEntities.upsert({
        entity_type: 'property',
        entity_id: entityId,
        entity_data: match.entity_data,
        is_monitored: false,
        label: match.label,
        created_by: match.created_by,
      });

      await ctx.auditLog.write({
        action: 'property.untracked',
        resource_type: 'saved_entity',
        resource_id: match.id,
        metadata: { entity_id: entityId },
      });

      // Ryd BBR-objekt indeks asynkront
      cleanupBbrTrackedObjects(
        auth.tenantId,
        entityId,
        match.entity_data as Record<string, unknown>
      ).catch(() => {});
    }

    writeAuditLog({
      action: 'tracked_property.toggle',
      resource_type: 'property',
      resource_id: 'unknown',
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[tracked DELETE]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
