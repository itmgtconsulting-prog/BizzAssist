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
const MAX_PER_RUN = 50;

/** Vercel Cron — kræver CRON_SECRET som Bearer token i Authorization-header */
function verifyCronSecret(request: NextRequest): boolean {
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

/**
 * GET /api/cron/poll-properties
 *
 * Hovedkørsel: poller alle fulgte ejendomme på tværs af alle tenants.
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

      for (const entity of monitored) {
        totalProcessed++;

        // Definer hvilke datapunkter der overvåges
        const checks: {
          type: SnapshotType;
          fetcher: () => Promise<Record<string, unknown> | null>;
        }[] = [
          { type: 'bbr', fetcher: () => fetchBBR(entity.entity_id, baseUrl) },
          { type: 'vurdering', fetcher: () => fetchVurdering(entity.entity_id, baseUrl) },
          { type: 'ejerskab', fetcher: () => fetchEjerskab(entity.entity_id, baseUrl) },
        ];

        for (const check of checks) {
          try {
            const currentData = await check.fetcher();
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
              totalChanges++;
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
      }
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
