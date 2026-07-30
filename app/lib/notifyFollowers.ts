/**
 * Følger-e-mail-dispatch — app/lib/notifyFollowers.ts
 *
 * Delt logik der afsender e-mails for ikke-afsendte change-notifikationer i
 * tenant_*.notifications. Bruges af:
 *   - /api/cron/notify-followers (manuel/ekstern trigger + simulation)
 *   - poll-properties-cronen (tail-kald, så daglig afsendelse sker uden en
 *     ekstra Vercel-cron — der er en hård grænse på ≤39 crons)
 *
 * Idempotent: hver notifikation markeres med email_sent_at efter behandling,
 * så den aldrig afsendes to gange.
 *
 * GDPR: e-mail-indhold persisteres ikke; entitets-label/modtager logges aldrig.
 *
 * RESTRICTED — SERVER-SIDE ONLY (bruger service_role admin client).
 *
 * @module app/lib/notifyFollowers
 */
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { sendEntityChangeEmail, type EntityChangeKind } from '@/app/lib/email';

/** Default max antal e-mails pr. dispatch — holder os inden for serverless-timeout */
const DEFAULT_MAX_PER_RUN = 200;

/** En ikke-afsendt change-notifikation som den læses fra databasen */
interface PendingNotification {
  id: string;
  user_id: string;
  entity_id: string;
  entity_type: EntityChangeKind;
  title: string;
  message: string | null;
  created_at: string;
}

/** Resultat af en dispatch-kørsel */
export interface DispatchResult {
  /** Antal e-mails afsendt */
  sent: number;
  /** Antal afsendelser der fejlede */
  failed: number;
}

/**
 * Bygger dyb-link til entitetens detaljeside ud fra type og id.
 *
 * @param baseUrl - App'ens base-URL
 * @param entityType - property/company/person
 * @param entityId - DAWA-UUID (ejendom), CVR (virksomhed) eller enhedsnummer (person)
 * @returns Absolut URL til detaljesiden
 */
function buildEntityLink(baseUrl: string, entityType: EntityChangeKind, entityId: string): string {
  switch (entityType) {
    case 'property':
      return `${baseUrl}/dashboard/ejendomme/${entityId}`;
    case 'company':
      return `${baseUrl}/dashboard/companies/${entityId}`;
    case 'person':
      return `${baseUrl}/dashboard/owners/${entityId}`;
  }
}

/**
 * Afsender e-mails for alle ikke-afsendte change-notifikationer på tværs af
 * alle tenants, og markerer dem som afsendt (email_sent_at).
 *
 * @param opts - Valgfri grænse for antal e-mails pr. kørsel
 * @returns Antal afsendte og fejlede e-mails
 */
export async function dispatchFollowerEmails(opts?: {
  maxPerRun?: number;
}): Promise<DispatchResult> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bizzassist.dk';
  const admin = createAdminClient();

  const { data: tenants, error: tenantErr } = (await admin
    .from('tenants')
    .select('id, schema_name')) as {
    data: { id: string; schema_name: string }[] | null;
    error: unknown;
  };

  if (tenantErr || !tenants) {
    logger.error('[notifyFollowers] Kunne ikke hente tenants:', tenantErr);
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;
  let remaining = opts?.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  // Cache for e-mail-opslag pr. bruger inden for kørslen (null = ingen e-mail)
  const emailCache = new Map<string, string | null>();

  for (const tenant of tenants) {
    if (remaining <= 0) break;

    try {
      const db = tenantDb(tenant.schema_name);

      const { data: pending } = (await db
        .from('notifications')
        .select('id, user_id, entity_id, entity_type, title, message, created_at')
        .is('email_sent_at', null)
        .order('created_at', { ascending: true })
        .limit(remaining)) as { data: PendingNotification[] | null };

      if (!pending || pending.length === 0) continue;

      for (const n of pending) {
        // 1. Slå følgerens e-mail op (cached pr. bruger)
        let email = emailCache.get(n.user_id);
        if (email === undefined) {
          const { data: u } = await admin.auth.admin.getUserById(n.user_id);
          email = u?.user?.email ?? null;
          emailCache.set(n.user_id, email);
        }

        // 2. Hent entitetens label (fallback: entity_id)
        let entityLabel = n.entity_id;
        const { data: saved } = (await db
          .from('saved_entities')
          .select('label')
          .eq('entity_id', n.entity_id)
          .limit(1)
          .maybeSingle()) as { data: { label: string | null } | null };
        if (saved?.label) entityLabel = saved.label;

        // 3. Send (kun hvis brugeren har en e-mail)
        if (email) {
          try {
            await sendEntityChangeEmail({
              to: email,
              entityType: n.entity_type,
              entityLabel,
              changeTitle: n.title,
              changeMessage: n.message ?? n.title,
              link: buildEntityLink(baseUrl, n.entity_type, n.entity_id),
              changedAt: new Date(n.created_at),
            });
            sent++;
          } catch (err) {
            failed++;
            logger.error('[notifyFollowers] Afsendelse fejlede:', err);
          }
        }

        // 4. Marker som afsendt (også ved manglende e-mail → undgå retry-loop)
        await db
          .from('notifications')
          .update({ email_sent_at: new Date().toISOString() })
          .eq('id', n.id);

        remaining--;
        if (remaining <= 0) break;
      }
    } catch (err) {
      logger.error(`[notifyFollowers] Tenant ${tenant.schema_name} fejlede:`, err);
    }
  }

  return { sent, failed };
}
