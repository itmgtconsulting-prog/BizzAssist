/**
 * Webhook: BBR hændelser push fra Datafordeler — /api/webhooks/bbr-events
 *
 * Modtager real-time BBR hændelser direkte fra Datafordelers
 * Hændelsesabonnement (push-model). Komplementerer pull-cronen med
 * øjeblikkelige notifikationer ved ændringer i fulgte ejendomme.
 *
 * Autentificering:
 *   Datafordeler kalder dette endpoint med Authorization: Bearer <BBR_WEBHOOK_SECRET>.
 *   BBR_WEBHOOK_SECRET er en hemmelig streng du genererer og angiver ved
 *   abonnement-registrering i Datafordelers selvbetjeningsportal.
 *
 * Event-format (Datafordeler BBR push):
 *   POST body: JSON med samme format som pull-API'ets data-array.
 *   Enkelt event eller array af events.
 *
 * Flow:
 *   1. Valider Authorization header mod BBR_WEBHOOK_SECRET
 *   2. Parse event(s) fra request body
 *   3. Match mod public.bbr_tracked_objects
 *   4. Opret notifikationer for berørte tenants
 *   5. Returnér 200 OK (Datafordeler genforsøger ved non-2xx)
 *
 * @module api/webhooks/bbr-events
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

/** BBR objekt-typer der overvåges */
const BBR_TYPER = new Set(['Bygning', 'Grund', 'Enhed']);

/** Enkelt BBR hændelse fra Datafordeler */
interface BbrHaendelse {
  id?: string;
  registreringstidspunkt: string;
  entitetUUID: string;
  objekttype: string;
  eventtype: 'Oprettelse' | 'Rettelse' | 'Nedlæggelse';
}

/**
 * Verificerer webhook-hemmelighed i Authorization header.
 * Datafordeler sender: "Authorization: Bearer <BBR_WEBHOOK_SECRET>"
 *
 * @param request - Indgående HTTP request
 * @returns true hvis hemmelighed er gyldig
 */
function verifyWebhookSecret(request: NextRequest): boolean {
  const secret = process.env.BBR_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[bbr-webhook] BBR_WEBHOOK_SECRET ikke konfigureret');
    return false;
  }
  const auth = request.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

/**
 * POST /api/webhooks/bbr-events
 *
 * Modtager og behandler BBR-hændelser fra Datafordeler push-abonnement.
 * Returnerer altid 200 ved valideret request — Datafordeler genforsøger
 * ved non-2xx svar, så vi logger fejl men returnerer 200 for at undgå
 * duplikat-notifikationer.
 */
export async function POST(request: NextRequest) {
  // ── 1. Valider hemmelighed ─────────────────────────────────────────────────
  if (!verifyWebhookSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── 2. Parse body ─────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  // Datafordeler kan sende enkelt event eller array
  const events: BbrHaendelse[] = Array.isArray(body) ? body : [body as BbrHaendelse];

  // Filtrer til relevante BBR-typer
  const relevantEvents = events.filter((e) => e?.entitetUUID && BBR_TYPER.has(e.objekttype));

  if (relevantEvents.length === 0) {
    return NextResponse.json({ ok: true, matched: 0 });
  }

  const admin = createAdminClient();

  try {
    // ── 3. Match mod tracked objects ─────────────────────────────────────────
    const objektIds = [...new Set(relevantEvents.map((e) => e.entitetUUID))];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAny = admin as any;

    const { data: matches } = (await adminAny
      .from('bbr_tracked_objects')
      .select('tenant_id, bfe_nummer, bbr_object_id')
      .in('bbr_object_id', objektIds)) as {
      data: { tenant_id: string; bfe_nummer: string; bbr_object_id: string }[] | null;
    };

    if (!matches || matches.length === 0) {
      return NextResponse.json({ ok: true, matched: 0 });
    }

    // Byg objekt-ID → tenants map
    const objectToTenants = new Map<string, { tenantId: string; bfeNummer: string }[]>();
    for (const m of matches) {
      const key = m.bbr_object_id;
      if (!objectToTenants.has(key)) objectToTenants.set(key, []);
      objectToTenants.get(key)!.push({
        tenantId: m.tenant_id,
        bfeNummer: m.bfe_nummer,
      });
    }

    // Hent tenant schema-navne
    const tenantIds = [...new Set(matches.map((m) => m.tenant_id as string))];
    const { data: tenants } = (await admin
      .from('tenants')
      .select('id, schema_name')
      .in('id', tenantIds)) as { data: { id: string; schema_name: string }[] | null };

    const tenantSchemaMap = new Map<string, string>(
      (tenants ?? []).map((t) => [t.id, t.schema_name])
    );

    // ── 4. Opret notifikationer ───────────────────────────────────────────────
    let totalNotifications = 0;

    for (const evt of relevantEvents) {
      const tenantMatches = objectToTenants.get(evt.entitetUUID);
      if (!tenantMatches) continue;

      const eventLabel =
        evt.objekttype === 'Bygning' ? 'Bygning' : evt.objekttype === 'Grund' ? 'Grund' : 'Enhed';

      const changeLabel =
        evt.eventtype === 'Oprettelse'
          ? 'oprettet'
          : evt.eventtype === 'Nedlæggelse'
            ? 'nedlagt'
            : 'ændret';

      for (const { tenantId, bfeNummer } of tenantMatches) {
        const schemaName = tenantSchemaMap.get(tenantId);
        if (!schemaName) continue;

        const { data: members } = await admin
          .from('tenant_memberships')
          .select('user_id')
          .eq('tenant_id', tenantId);

        const userIds = (members ?? []).map((m: { user_id: string }) => m.user_id);
        if (userIds.length === 0) continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = (admin as any).schema(schemaName);

        for (const userId of userIds) {
          await db.from('notifications').insert({
            tenant_id: tenantId,
            user_id: userId,
            entity_id: bfeNummer,
            entity_type: 'property',
            notification_type: 'bbr_change',
            title: `BBR-data ${changeLabel}`,
            message: `${eventLabel} ${changeLabel} på ejendom ${bfeNummer} (real-time hændelse)`,
            metadata: {
              bbr_object_id: evt.entitetUUID,
              bbr_object_type: evt.objekttype,
              eventtype: evt.eventtype,
              registreringstidspunkt: evt.registreringstidspunkt,
              source: 'push',
            },
          });
          totalNotifications++;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      events: relevantEvents.length,
      matched: matches.length,
      notifications: totalNotifications,
    });
  } catch (err) {
    // Returner 200 for at undgå Datafordeler genforsøg — log fejlen
    console.error('[bbr-webhook] Fejl ved behandling:', err);
    return NextResponse.json({ ok: true, error: 'Intern fejl — se logs' });
  }
}
