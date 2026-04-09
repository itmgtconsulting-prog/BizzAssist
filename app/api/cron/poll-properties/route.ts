/**
 * Cron: Poll monitored properties for changes — /api/cron/poll-properties
 *
 * Nætlig polling af fulgte ejendomme for ændringer i:
 *   - BBR-data (areal, byggeår, bygningsstatus)
 *   - Vurdering (ejendomsværdi, grundværdi)
 *   - Ejerskab (ejerskifte)
 *
 * For hver fulgt ejendom:
 *   1. Henter aktuelle data fra BizzAssist interne API'er
 *   2. Beregner SHA-256 hash af relevante felter
 *   3. Sammenligner med seneste snapshot
 *   4. Hvis hash er ændret → opretter nyt snapshot + notifikation
 *
 * Sikring:
 *   - Kræver CRON_SECRET header (Vercel Cron eller manuelt kald)
 *   - Bruger admin client (service_role) — kører uden brugersession
 *   - Rate limiter: max 50 ejendomme pr. kørsel
 *
 * Trigger:
 *   - Vercel Cron: tilføj til vercel.json
 *   - Manuel: GET /api/cron/poll-properties med Authorization: Bearer <CRON_SECRET>
 *
 * @module api/cron/poll-properties
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SnapshotType, NotificationType } from '@/lib/db/tenant';

/** Max antal ejendomme pr. cron-kørsel */
const MAX_PER_RUN = 150;

/** Antal ejendomme der polles parallelt i hver batch */
const BATCH_SIZE = 10;

/** Pause mellem batches i millisekunder — undgår rate limiting hos eksterne API'er */
const BATCH_DELAY_MS = 100;

/** Vercel Cron — kræver CRON_SECRET som Bearer token i Authorization-header */
function verifyCronSecret(request: NextRequest): boolean {
  // In production, require Vercel's cron header to prevent external triggering
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // Kræver CRON_SECRET i .env
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

/**
 * Simpel SHA-256 hash af en JSON-struktur.
 * Bruges til at detektere ændringer i ejendomsdata.
 */
async function hashData(data: unknown): Promise<string> {
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(
    JSON.stringify(data, Object.keys(data as Record<string, unknown>).sort())
  );
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Henter BBR-data for en ejendom via intern API.
 * Returnerer et forenklet objekt med de felter vi overvåger.
 */
async function fetchBBR(
  entityId: string,
  baseUrl: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${baseUrl}/api/ejendom?id=${entityId}&inkluder=bbr`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Udtræk monitorerbare felter
    return {
      bygninger:
        data?.bbr?.bygninger?.map((b: Record<string, unknown>) => ({
          id: b.id,
          status: b.status,
          areal: b.bygningsareal,
          etager: b.etager,
          opfoerelsesaar: b.opfoerelsesaar,
          anvendelse: b.anvendelse,
        })) ?? [],
      grunde:
        data?.bbr?.grunde?.map((g: Record<string, unknown>) => ({
          id: g.id,
          grundareal: g.grundareal,
        })) ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Henter vurderingsdata for en ejendom via intern API.
 */
async function fetchVurdering(
  entityId: string,
  baseUrl: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${baseUrl}/api/vurdering?id=${entityId}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      ejendomsvaerdi: data?.ejendomsvaerdi ?? null,
      grundvaerdi: data?.grundvaerdi ?? null,
      vurderingsaar: data?.vurderingsaar ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Henter ejerskabsdata for en ejendom via intern API.
 */
async function fetchEjerskab(
  entityId: string,
  baseUrl: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${baseUrl}/api/ejerskab?id=${entityId}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      ejere:
        data?.ejere?.map((e: Record<string, unknown>) => ({
          navn: e.navn,
          ejerandel: e.ejerandel,
        })) ?? [],
    };
  } catch {
    return null;
  }
}

/** Mapping fra snapshot-type til notifikationstype */
const SNAPSHOT_TO_NOTIFICATION: Record<SnapshotType, NotificationType> = {
  bbr: 'bbr_change',
  vurdering: 'vurdering_change',
  ejerskab: 'ejerskifte',
  energi: 'energi_change',
  plan: 'plan_change',
  cvr: 'cvr_change',
};

/** Dansk beskrivelse af ændring pr. type */
const CHANGE_TITLES: Record<SnapshotType, string> = {
  bbr: 'BBR-data ændret',
  vurdering: 'Ny vurdering',
  ejerskab: 'Ejerskifte registreret',
  energi: 'Energimærke opdateret',
  plan: 'Plandata ændret',
  cvr: 'CVR-data ændret',
};

/** Resultat fra polling af en enkelt ejendom */
interface PropertyPollResult {
  changes: number;
  errors: string[];
}

/**
 * Delay-hjælper — venter det angivne antal millisekunder.
 *
 * @param ms - Antal millisekunder at vente
 * @returns Promise der resolves efter `ms` millisekunder
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poller en enkelt ejendom for ændringer i BBR, vurdering og ejerskab.
 *
 * Henter alle tre datatyper parallelt, sammenligner SHA-256 hashes med
 * seneste snapshot, og opretter nye snapshots + notifikationer ved ændringer.
 *
 * @param entity - Den fulgte ejendom fra saved_entities
 * @param tenant - Tenant-info med id og schema_name
 * @param baseUrl - Base-URL for interne API-kald
 * @param db - Supabase-klient scopet til tenant-schema
 * @param userIds - Bruger-IDs i tenanten (til notifikationer)
 * @returns Antal ændringer fundet og eventuelle fejl
 */
async function pollSingleProperty(
  entity: { entity_id: string; label: string },
  tenant: { id: string; schema_name: string },
  baseUrl: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  userIds: string[]
): Promise<PropertyPollResult> {
  let changes = 0;
  const errors: string[] = [];

  // Definer hvilke datapunkter der overvåges
  const checks: {
    type: SnapshotType;
    fetcher: () => Promise<Record<string, unknown> | null>;
  }[] = [
    { type: 'bbr', fetcher: () => fetchBBR(entity.entity_id, baseUrl) },
    { type: 'vurdering', fetcher: () => fetchVurdering(entity.entity_id, baseUrl) },
    { type: 'ejerskab', fetcher: () => fetchEjerskab(entity.entity_id, baseUrl) },
  ];

  // Hent alle 3 datatyper parallelt for denne ejendom
  const fetchResults = await Promise.allSettled(
    checks.map((check) => check.fetcher().then((data) => ({ check, data })))
  );

  for (const result of fetchResults) {
    if (result.status === 'rejected') {
      errors.push(`${tenant.schema_name}/${entity.entity_id}: ${result.reason}`);
      continue;
    }

    const { check, data: currentData } = result.value;

    try {
      if (!currentData) continue; // API-fejl — spring over

      const currentHash = await hashData(currentData);

      // Hent seneste snapshot
      const { data: latest } = await db
        .from('property_snapshots')
        .select('snapshot_hash')
        .eq('tenant_id', tenant.id)
        .eq('entity_id', entity.entity_id)
        .eq('snapshot_type', check.type)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latest && latest.snapshot_hash === currentHash) {
        continue; // Ingen ændring
      }

      // Opret nyt snapshot
      await db.from('property_snapshots').insert({
        tenant_id: tenant.id,
        entity_id: entity.entity_id,
        snapshot_type: check.type,
        snapshot_hash: currentHash,
        snapshot_data: currentData,
      });

      // Kun opret notifikation hvis der fandtes et tidligere snapshot
      // (første gang er baseline — ingen notifikation)
      if (latest) {
        changes++;
        const adresse = entity.label || entity.entity_id;
        const title = CHANGE_TITLES[check.type];
        const message = `${title} på ${adresse}`;

        // Opret notifikation for alle brugere i tenant'en
        for (const userId of userIds) {
          await db.from('notifications').insert({
            tenant_id: tenant.id,
            user_id: userId,
            entity_id: entity.entity_id,
            entity_type: 'property',
            notification_type: SNAPSHOT_TO_NOTIFICATION[check.type],
            title,
            message,
            metadata: {
              previous_hash: latest.snapshot_hash,
              current_hash: currentHash,
            },
          });
        }
      }
    } catch (err) {
      errors.push(`${tenant.schema_name}/${entity.entity_id}/${check.type}: ${err}`);
    }
  }

  return { changes, errors };
}

/**
 * Processer et array af ejendomme i parallelle batches.
 *
 * Bruger Promise.allSettled() så fejl i én ejendom ikke blokerer de øvrige.
 * Indsætter en kort pause mellem batches for at undgå rate limiting hos
 * eksterne API'er (Datafordeler, BBR, mv.).
 *
 * @param entities - Array af fulgte ejendomme
 * @param tenant - Tenant-info med id og schema_name
 * @param baseUrl - Base-URL for interne API-kald
 * @param db - Supabase-klient scopet til tenant-schema
 * @param userIds - Bruger-IDs i tenanten (til notifikationer)
 * @returns Samlet antal ændringer og fejl
 */
async function processEntitiesInBatches(
  entities: { entity_id: string; label: string }[],
  tenant: { id: string; schema_name: string },
  baseUrl: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  userIds: string[]
): Promise<PropertyPollResult> {
  let totalChanges = 0;
  const allErrors: string[] = [];

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch = entities.slice(i, i + BATCH_SIZE);

    // Kør hele batch'en parallelt med Promise.allSettled
    const results = await Promise.allSettled(
      batch.map((entity) => pollSingleProperty(entity, tenant, baseUrl, db, userIds))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        totalChanges += result.value.changes;
        allErrors.push(...result.value.errors);
      } else {
        // Uventet fejl i hele property-poll — burde ikke ske da pollSingleProperty fanger fejl
        allErrors.push(`${tenant.schema_name}/batch-error: ${result.reason}`);
      }
    }

    // Kort pause mellem batches for at undgå rate limiting
    if (i + BATCH_SIZE < entities.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  return { changes: totalChanges, errors: allErrors };
}

/**
 * GET /api/cron/poll-properties
 *
 * Hovedkørsel: poller alle fulgte ejendomme på tværs af alle tenants.
 *
 * BIZZ-177: Ejendomme polles nu i parallelle batches (BATCH_SIZE ad gangen)
 * i stedet for sekventielt. Med 150 ejendomme og BATCH_SIZE=10 kører vi
 * 15 batches i stedet for 150 serielle kald, hvilket holder os inden for
 * Vercels 60-sekunders timeout for serverless functions.
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const admin = createAdminClient();

  // Hent alle tenants
  const { data: tenants, error: tenantErr } = (await admin
    .from('tenants')
    .select('id, schema_name')) as {
    data: { id: string; schema_name: string }[] | null;
    error: unknown;
  };

  if (tenantErr || !tenants) {
    console.error('[cron] Kunne ikke hente tenants:', tenantErr);
    return NextResponse.json({ error: 'Kunne ikke hente tenants' }, { status: 500 });
  }

  let totalProcessed = 0;
  let totalChanges = 0;
  const errors: string[] = [];

  for (const tenant of tenants) {
    if (totalProcessed >= MAX_PER_RUN) break;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (admin as any).schema(tenant.schema_name);

      // Hent alle fulgte ejendomme for denne tenant
      const { data: monitored } = await db
        .from('saved_entities')
        .select('entity_id, label, entity_data, created_by')
        .eq('tenant_id', tenant.id)
        .eq('entity_type', 'property')
        .eq('is_monitored', true)
        .limit(MAX_PER_RUN - totalProcessed);

      if (!monitored || monitored.length === 0) continue;

      // Hent alle membership user_ids for notifikationer
      const { data: members } = await admin
        .from('tenant_memberships')
        .select('user_id')
        .eq('tenant_id', tenant.id);
      const userIds = (members ?? []).map((m: { user_id: string }) => m.user_id);

      // BIZZ-177: Processer ejendomme i parallelle batches
      const result = await processEntitiesInBatches(
        monitored as { entity_id: string; label: string }[],
        tenant,
        baseUrl,
        db,
        userIds
      );

      totalProcessed += monitored.length;
      totalChanges += result.changes;
      errors.push(...result.errors);
    } catch (err) {
      errors.push(`tenant ${tenant.schema_name}: ${err}`);
    }
  }

  return NextResponse.json({
    ok: true,
    processed: totalProcessed,
    changes: totalChanges,
    errors: errors.length,
    ...(errors.length > 0 ? { errorDetails: errors.slice(0, 10) } : {}),
  });
}
