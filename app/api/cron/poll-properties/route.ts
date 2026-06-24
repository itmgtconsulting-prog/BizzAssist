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
import { createAdminClient, tenantDb, type TenantDb } from '@/lib/supabase/admin';
import type { SnapshotType, NotificationType } from '@/lib/db/tenant';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { dispatchFollowerEmails } from '@/app/lib/notifyFollowers';
import { fetchBbrPollSnapshot, fetchOwnershipPollSnapshot } from '@/app/lib/propertyPollData';

export const maxDuration = 300;

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
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
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
 * Detekterer ændring for én datatype: hasher data, sammenligner med seneste
 * snapshot, gemmer nyt snapshot, og opretter notifikation til alle tenant-brugere
 * hvis der allerede fandtes en baseline (første kørsel = baseline → ingen
 * notifikation, så vi ikke spammer ved første polling).
 *
 * @param type - Snapshot-type (bbr/ejerskab)
 * @param currentData - De aktuelle overvågede data
 * @param entity - Den fulgte ejendom
 * @param tenant - Tenant-info
 * @param db - Supabase-klient scopet til tenant-schema
 * @param userIds - Bruger-IDs der skal notificeres
 * @returns true hvis en ændring blev detekteret og notifikation oprettet
 */
async function detectChange(
  type: SnapshotType,
  currentData: Record<string, unknown>,
  entity: { entity_id: string; label: string },
  tenant: { id: string; schema_name: string },
  db: TenantDb,
  userIds: string[]
): Promise<boolean> {
  const currentHash = await hashData(currentData);

  const { data: latest } = await db
    .from('property_snapshots')
    .select('snapshot_hash')
    .eq('tenant_id', tenant.id)
    .eq('entity_id', entity.entity_id)
    .eq('snapshot_type', type)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latest && latest.snapshot_hash === currentHash) return false; // ingen ændring

  // Gem/opdatér snapshot (én række pr. (tenant, entity, type) — se mig 189).
  // Upsert så en detekteret ændring faktisk persisteres; ellers ville hver
  // kørsel re-detektere og gen-notificere (BIZZ-2194).
  const { error: snapErr } = await db.from('property_snapshots').upsert(
    {
      tenant_id: tenant.id,
      entity_id: entity.entity_id,
      snapshot_type: type,
      snapshot_hash: currentHash,
      snapshot_data: currentData,
    },
    { onConflict: 'tenant_id,entity_id,snapshot_type' }
  );

  // Kunne ikke gemme snapshot → undlad notifikation, så vi ikke gen-notificerer
  // i en endeløs løkke ved gentagne kørsler.
  if (snapErr) {
    logger.warn(`[poll-properties] snapshot-upsert fejl (${type}):`, snapErr.message);
    return false;
  }

  if (!latest) return false; // første gang = baseline → ingen notifikation

  const adresse = entity.label || entity.entity_id;
  const title = CHANGE_TITLES[type];
  const message = `${title} på ${adresse}`;

  for (const userId of userIds) {
    await db.from('notifications').insert({
      tenant_id: tenant.id,
      user_id: userId,
      entity_id: entity.entity_id,
      entity_type: 'property',
      notification_type: SNAPSHOT_TO_NOTIFICATION[type],
      title,
      message,
      metadata: { previous_hash: latest.snapshot_hash, current_hash: currentHash },
    });
  }
  return true;
}

/**
 * Poller en enkelt ejendom for ændringer i BBR og ejerskab.
 *
 * BIZZ-2194: Læser data direkte via service-role (fetchBbrForAddress +
 * backfill-tabellen ejf_ejerskab) i stedet for de auth-beskyttede HTTP-routes,
 * der ikke kan kaldes uden brugersession. BBR-opslaget giver også BFE-nummeret,
 * som ejerskab-opslaget kræver. (Vurdering overvåges ikke her endnu — den
 * eksisterende /api/vurdering har kun en in-memory cache uden persistent kilde
 * cronen kan læse; spores som separat opgave.)
 *
 * @param entity - Den fulgte ejendom fra saved_entities
 * @param tenant - Tenant-info med id og schema_name
 * @param db - Supabase-klient scopet til tenant-schema
 * @param userIds - Bruger-IDs i tenanten (til notifikationer)
 * @returns Antal ændringer fundet og eventuelle fejl
 */
async function pollSingleProperty(
  entity: { entity_id: string; label: string; bfe?: number | null },
  tenant: { id: string; schema_name: string },
  db: TenantDb,
  userIds: string[]
): Promise<PropertyPollResult> {
  let changes = 0;
  const errors: string[] = [];

  try {
    // BBR (best-effort) — giver også BFE hvis vi ikke kender det i forvejen
    const bbrSnap = await fetchBbrPollSnapshot(entity.entity_id);
    if (bbrSnap) {
      if (await detectChange('bbr', bbrSnap.monitored, entity, tenant, db, userIds)) changes++;
    }

    // BFE: brug det kendte fra saved_entities (sat ved follow-tid) hvis muligt,
    // ellers fra BBR-opslaget. Ejerskab-detektering virker dermed også selvom
    // BBR-opslaget fejler, så længe BFE er kendt.
    const bfe = entity.bfe ?? bbrSnap?.bfe ?? null;
    if (bfe != null) {
      const own = await fetchOwnershipPollSnapshot(bfe);
      if (own) {
        const ownData = { ejere: own.ejere };
        if (await detectChange('ejerskab', ownData, entity, tenant, db, userIds)) changes++;
      }
    }
  } catch (err) {
    errors.push(`${tenant.schema_name}/${entity.entity_id}: ${err}`);
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
 * @param db - Supabase-klient scopet til tenant-schema
 * @param userIds - Bruger-IDs i tenanten (til notifikationer)
 * @returns Samlet antal ændringer og fejl
 */
async function processEntitiesInBatches(
  entities: { entity_id: string; label: string; bfe?: number | null }[],
  tenant: { id: string; schema_name: string },
  db: TenantDb,
  userIds: string[]
): Promise<PropertyPollResult> {
  let totalChanges = 0;
  const allErrors: string[] = [];

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch = entities.slice(i, i + BATCH_SIZE);

    // Kør hele batch'en parallelt med Promise.allSettled
    const results = await Promise.allSettled(
      batch.map((entity) => pollSingleProperty(entity, tenant, db, userIds))
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

  // BIZZ-621 + BIZZ-624: heartbeat + Sentry cron-monitoring.
  return withCronMonitor(
    { jobName: 'poll-properties', schedule: '0 3 * * *', intervalMinutes: 1440 },
    async () => {
      const admin = createAdminClient();

      // Hent alle tenants
      const { data: tenants, error: tenantErr } = (await admin
        .from('tenants')
        .select('id, schema_name')) as {
        data: { id: string; schema_name: string }[] | null;
        error: unknown;
      };

      if (tenantErr || !tenants) {
        logger.error('[cron] Kunne ikke hente tenants:', tenantErr);
        return NextResponse.json({ error: 'Kunne ikke hente tenants' }, { status: 500 });
      }

      let totalProcessed = 0;
      let totalChanges = 0;
      const errors: string[] = [];

      for (const tenant of tenants) {
        if (totalProcessed >= MAX_PER_RUN) break;

        try {
          const db = tenantDb(tenant.schema_name);

          // Hent alle fulgte ejendomme for denne tenant
          const { data: monitored } = await db
            .from('saved_entities')
            .select('entity_id, label, entity_data, created_by')
            .eq('tenant_id', tenant.id)
            .eq('entity_type', 'property')
            .eq('is_monitored', true)
            .limit(MAX_PER_RUN - totalProcessed);

          if (!monitored || monitored.length === 0) continue;

          // Udtræk kendt BFE fra entity_data (sat ved follow-tid) hvis muligt
          const monitoredEntities = (
            monitored as Array<{
              entity_id: string;
              label: string;
              entity_data?: Record<string, unknown> | null;
            }>
          ).map((m) => {
            const ed = m.entity_data ?? {};
            const rawBfe = ed.bfe ?? ed.bfeNummer ?? ed.bfe_nummer;
            const bfe = typeof rawBfe === 'number' ? rawBfe : Number(rawBfe);
            return {
              entity_id: m.entity_id,
              label: m.label,
              bfe: Number.isFinite(bfe) ? bfe : null,
            };
          });

          // Hent alle membership user_ids for notifikationer
          const { data: members } = await admin
            .from('tenant_memberships')
            .select('user_id')
            .eq('tenant_id', tenant.id);
          const userIds = (members ?? []).map((m: { user_id: string }) => m.user_id);

          // BIZZ-177: Processer ejendomme i parallelle batches
          const result = await processEntitiesInBatches(monitoredEntities, tenant, db, userIds);

          totalProcessed += monitored.length;
          totalChanges += result.changes;
          errors.push(...result.errors);
        } catch (err) {
          errors.push(`tenant ${tenant.schema_name}: ${err}`);
        }
      }

      // BIZZ-2194: Afsend e-mails for de change-notifikationer denne (og
      // pull-bbr-events-) kørsel har oprettet. Kører som tail-kald her i stedet
      // for som separat Vercel-cron, da der er en hård grænse på ≤39 crons.
      // Idempotent via email_sent_at, så intet dobbelt-afsendes.
      let emailsSent = 0;
      try {
        const dispatch = await dispatchFollowerEmails();
        emailsSent = dispatch.sent;
      } catch (err) {
        errors.push(`notify-followers: ${err}`);
      }

      return NextResponse.json({
        ok: true,
        processed: totalProcessed,
        changes: totalChanges,
        emailsSent,
        errors: errors.length,
        ...(errors.length > 0 ? { errorDetails: errors.slice(0, 10) } : {}),
      });
    }
  );
}
