/**
 * Cron: Pull BBR hændelser fra Datafordeler — /api/cron/pull-bbr-events
 *
 * Henter BBR-hændelser (Bygning, Grund, Enhed) fra Datafordelers
 * Hændelsesbesked API siden seneste cursor-tidsstempel.
 *
 * Flow:
 *   1. Hent cursor (last_event_at) fra public.bbr_event_cursor
 *   2. Kald Datafordeler Hændelsesbesked API for BBR-hændelser siden cursor
 *   3. Match events mod public.bbr_tracked_objects (BBR objekt-UUID → BFE)
 *   4. Opret notifikationer for berørte tenants (samme mønster som poll-properties)
 *   5. Opdater cursor til seneste event-tidsstempel
 *
 * Sikring:
 *   - Kræver CRON_SECRET header
 *   - x-vercel-cron: 1 header kræves i production
 *   - Kræver DATAFORDELER_USER + DATAFORDELER_PASS
 *   - Maks 500 events pr. kørsel (pagineret)
 *
 * Trigger: Vercel Cron — kører hvert 6. time (se vercel.json)
 *
 * @module api/cron/pull-bbr-events
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

/** Datafordeler Hændelsesbesked base URL */
const HHAENDELSE_BASE = 'https://hændelsesbesked.datafordeler.dk/api/v1/hændelse';

/** Maks antal events der behandles pr. kørsel */
const MAX_EVENTS = 500;

/** Sideindlæsning — Datafordeler maks pagesize */
const PAGE_SIZE = 100;

/**
 * BBR objekt-typer vi overvåger.
 * BIZZ-489: Udvidet med TekniskAnlaeg, Opgang og Etage så fulgte ejendomme
 * får besked når der fx tilføjes solceller, ændres etageopdeling, eller
 * bygningens trapperums-struktur opdateres. Disse entiteter blev
 * integreret i datamodellen via BIZZ-486 (Opgang/Etage) og findes som
 * BBR_Opgang, BBR_Etage, BBR_TekniskAnlaeg i Datafordeler.
 */
const BBR_TYPER = ['Bygning', 'Grund', 'Enhed', 'TekniskAnlaeg', 'Opgang', 'Etage'] as const;
type BbrObjekttype = (typeof BBR_TYPER)[number];

/** Datafordeler BBR hændelse */
interface BbrHaendelse {
  id: string;
  registreringstidspunkt: string;
  entitetUUID: string;
  objekttype: string;
  eventtype: 'Oprettelse' | 'Rettelse' | 'Nedlæggelse';
}

/** Datafordeler pagineret svar */
interface HaendelseSvar {
  totalAntalSider: number;
  side: number;
  sideStørrelse: number;
  data: BbrHaendelse[];
}

/**
 * Verificerer at kaldet er autoriseret via CRON_SECRET.
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/**
 * Bygger Basic Auth header til Datafordeler.
 */
function datafordelerAuth(): string {
  const user = process.env.DATAFORDELER_USER ?? '';
  const pass = process.env.DATAFORDELER_PASS ?? '';
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * Henter én side BBR-hændelser fra Datafordeler Hændelsesbesked API.
 *
 * @param datefrom - ISO8601 tidsstempel (cursor)
 * @param side - Sidenummer (1-baseret)
 * @returns Pagineret svar med BBR-hændelser, eller null ved fejl
 */
async function fetchHaendelseSide(datefrom: string, side: number): Promise<HaendelseSvar | null> {
  const url = new URL(HHAENDELSE_BASE);
  url.searchParams.set('register', 'BBR');
  url.searchParams.set('datefrom', datefrom);
  url.searchParams.set('side', String(side));
  url.searchParams.set('pagesize', String(PAGE_SIZE));

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: datafordelerAuth() },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 204) return { totalAntalSider: 0, side: 1, sideStørrelse: 0, data: [] };
    if (!res.ok) {
      logger.error('[pull-bbr-events] Datafordeler svar:', res.status, await res.text());
      return null;
    }
    return (await res.json()) as HaendelseSvar;
  } catch (err) {
    logger.error('[pull-bbr-events] fetch fejl:', err);
    return null;
  }
}

/**
 * GET /api/cron/pull-bbr-events
 *
 * Henter og behandler BBR-hændelser siden seneste cursor.
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // BIZZ-621 + BIZZ-624: heartbeat + Sentry cron-monitoring.
  return withCronMonitor(
    { jobName: 'pull-bbr-events', schedule: '0 */6 * * *', intervalMinutes: 360 },
    async () => {
      if (!process.env.DATAFORDELER_USER || !process.env.DATAFORDELER_PASS) {
        return NextResponse.json(
          { error: 'DATAFORDELER_USER / DATAFORDELER_PASS ikke konfigureret' },
          { status: 500 }
        );
      }

      const admin = createAdminClient();

      // ── 1. Hent cursor ────────────────────────────────────────────────────────
      const { data: cursorRow, error: cursorErr } = await admin
        .from('bbr_event_cursor')
        .select('last_event_at')
        .eq('id', 1)
        .single();

      if (cursorErr || !cursorRow) {
        logger.error('[pull-bbr-events] Kunne ikke hente cursor:', cursorErr);
        return NextResponse.json({ error: 'Cursor fejl' }, { status: 500 });
      }

      const datefrom = cursorRow.last_event_at;

      // ── 2. Pull events fra Datafordeler (pagineret) ───────────────────────────
      const allEvents: BbrHaendelse[] = [];
      let side = 1;

      while (allEvents.length < MAX_EVENTS) {
        const svar = await fetchHaendelseSide(datefrom, side);
        if (!svar || svar.data.length === 0) break;

        for (const evt of svar.data) {
          if (BBR_TYPER.includes(evt.objekttype as BbrObjekttype)) {
            allEvents.push(evt);
          }
        }

        if (side >= svar.totalAntalSider) break;
        side++;
      }

      if (allEvents.length === 0) {
        // Opdater pulled_at selvom der ingen events var
        await admin
          .from('bbr_event_cursor')
          .update({ last_pulled_at: new Date().toISOString() })
          .eq('id', 1);
        return NextResponse.json({ ok: true, events: 0, notifications: 0 });
      }

      // ── 3. Match events mod tracked objects ───────────────────────────────────
      const eventObjektIds = [...new Set(allEvents.map((e) => e.entitetUUID))];

      const { data: matches } = await admin
        .from('bbr_tracked_objects')
        .select('tenant_id, bfe_nummer, bbr_object_id')
        .in('bbr_object_id', eventObjektIds);

      const latestAt = allEvents.reduce((latest, e) =>
        e.registreringstidspunkt > latest.registreringstidspunkt ? e : latest
      ).registreringstidspunkt;

      if (!matches || matches.length === 0) {
        // Opdater cursor til seneste event
        await admin
          .from('bbr_event_cursor')
          .update({ last_event_at: latestAt, last_pulled_at: new Date().toISOString() })
          .eq('id', 1);

        return NextResponse.json({ ok: true, events: allEvents.length, notifications: 0 });
      }

      // Byg et map: bbr_object_id → [{ tenant_id, bfe_nummer }]
      const objectToTenants = new Map<string, { tenantId: string; bfeNummer: string }[]>();
      for (const m of matches) {
        const key = m.bbr_object_id;
        if (!objectToTenants.has(key)) objectToTenants.set(key, []);
        objectToTenants.get(key)!.push({ tenantId: m.tenant_id, bfeNummer: m.bfe_nummer });
      }

      // ── 4. Opret notifikationer ────────────────────────────────────────────────
      // Hent tenant schema-navne og member-liste
      const tenantIds = [...new Set(matches.map((m) => m.tenant_id as string))];

      const { data: tenants } = (await admin
        .from('tenants')
        .select('id, schema_name')
        .in('id', tenantIds)) as { data: { id: string; schema_name: string }[] | null };

      const tenantSchemaMap = new Map<string, string>(
        (tenants ?? []).map((t) => [t.id, t.schema_name])
      );

      let totalNotifications = 0;

      for (const evt of allEvents) {
        const tenantMatches = objectToTenants.get(evt.entitetUUID);
        if (!tenantMatches) continue;

        // BIZZ-489: Map objekttype til læsbar dansk label.
        // TekniskAnlaeg får mere beskrivende label fordi brugere ikke kender termen.
        const eventLabelMap: Record<string, string> = {
          Bygning: 'Bygning',
          Grund: 'Grund',
          Enhed: 'Enhed',
          TekniskAnlaeg: 'Teknisk anlæg',
          Opgang: 'Opgang',
          Etage: 'Etage',
        };
        const eventLabel = eventLabelMap[evt.objekttype] ?? evt.objekttype;

        const changeLabel =
          evt.eventtype === 'Oprettelse'
            ? 'oprettet'
            : evt.eventtype === 'Nedlæggelse'
              ? 'nedlagt'
              : 'ændret';

        for (const { tenantId, bfeNummer } of tenantMatches) {
          const schemaName = tenantSchemaMap.get(tenantId);
          if (!schemaName) continue;

          // Hent tenant-medlemmer
          const { data: members } = await admin
            .from('tenant_memberships')
            .select('user_id')
            .eq('tenant_id', tenantId);

          const userIds = (members ?? []).map((m: { user_id: string }) => m.user_id);
          if (userIds.length === 0) continue;

          const db = tenantDb(schemaName);

          for (const userId of userIds) {
            await db.from('notifications').insert({
              tenant_id: tenantId,
              user_id: userId,
              entity_id: bfeNummer,
              entity_type: 'property',
              notification_type: 'bbr_change',
              title: `BBR-data ${changeLabel}`,
              message: `${eventLabel} ${changeLabel} på ejendom ${bfeNummer} (Datafordeler hændelse)`,
              metadata: {
                bbr_object_id: evt.entitetUUID,
                bbr_object_type: evt.objekttype,
                eventtype: evt.eventtype,
                registreringstidspunkt: evt.registreringstidspunkt,
              },
            });
            totalNotifications++;
          }
        }
      }

      // ── 5. Opdater cursor til seneste event-tidsstempel ────────────────────────
      await admin
        .from('bbr_event_cursor')
        .update({
          last_event_at: latestAt,
          last_pulled_at: new Date().toISOString(),
        })
        .eq('id', 1);

      return NextResponse.json({
        ok: true,
        events: allEvents.length,
        matched: matches.length,
        notifications: totalNotifications,
        cursor: latestAt,
      });
    }
  );
}
