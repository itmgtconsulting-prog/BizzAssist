/**
 * Tenant-schema completeness cron — /api/cron/verify-tenant-schemas
 *
 * Defense-in-depth-overvågning (BIZZ-2196): sweeper ALLE tenant-schemaer og finder
 * dem der mangler kerne-tabeller (fx ai_token_usage, audit_log) — en tilstand der
 * gør at features fejler i stilhed for den bruger. For hver ufuldstændig tenant:
 *   1. forsøger ÉN idempotent auto-reparation (public.provision_tenant_all_features),
 *   2. re-tjekker, og
 *   3. alarmerer service manager (sendCriticalAlert) hvis den STADIG er ufuldstændig.
 *
 * Komplementerer post-provisionerings-tjekket i provisionTenantForUser: fanger også
 * drift der opstår uden om signup-flowet (manuelle ændringer, fejlede migrationer).
 *
 * Security:
 *   - Requires Authorization: Bearer <CRON_SECRET>
 *   - In Vercel production also requires x-vercel-cron: 1
 *
 * Schedule: dagligt (0 4 * * *) — konfigureres i vercel.json.
 *
 * @module api/cron/verify-tenant-schemas
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { findIncompleteTenants, type TenantSchemaStatus } from '@/lib/tenant/verifyTenantSchema';
import { sendCriticalAlert } from '@/app/lib/service-manager-alerts';

export const maxDuration = 120;

/**
 * Verificér CRON_SECRET bearer-token (+ x-vercel-cron i prod).
 *
 * @param request - Indkommende request
 * @returns true hvis autoriseret
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

/** Find tenant-id ud fra schema_name via Management API (til reparations-kald). */
async function tenantIdForSchema(schemaName: string): Promise<string | null> {
  const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace('https://', '').split('.')[0];
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) return null;
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `SELECT id::text AS id FROM public.tenants WHERE schema_name = '${schemaName}' LIMIT 1`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Kør den idempotente orkestrator for ét schema (auto-reparation). */
async function repair(schemaName: string, tenantId: string): Promise<void> {
  const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace('https://', '').split('.')[0];
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) return;
  await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `SELECT public.provision_tenant_all_features('${schemaName}', '${tenantId}'::uuid)`,
    }),
    signal: AbortSignal.timeout(30000),
  }).catch((e) => logger.error('[verify-tenant-schemas] reparation fejlede:', e));
}

/**
 * GET-handler: sweep + auto-repair + alert.
 *
 * @param request - Skal bære CRON_SECRET bearer-token
 * @returns JSON: { ok, checked, repaired, stillIncomplete }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'verify-tenant-schemas', schedule: '0 4 * * *', intervalMinutes: 1440 },
    async () => {
      const incomplete = await findIncompleteTenants();
      if (incomplete === null) {
        return NextResponse.json({ error: 'Sweep fejlede' }, { status: 500 });
      }

      const repaired: string[] = [];
      const stillIncomplete: TenantSchemaStatus[] = [];

      for (const t of incomplete) {
        const tenantId = await tenantIdForSchema(t.schemaName);
        if (tenantId) await repair(t.schemaName, tenantId);
      }

      // Re-tjek efter reparation.
      const afterRepair = (await findIncompleteTenants()) ?? [];
      const stillByName = new Map(afterRepair.map((t) => [t.schemaName, t]));
      for (const t of incomplete) {
        const still = stillByName.get(t.schemaName);
        if (still) {
          stillIncomplete.push(still);
        } else {
          repaired.push(t.schemaName);
        }
      }

      // Alarmér service manager for hver tenant der STADIG er ufuldstændig.
      for (const t of stillIncomplete) {
        await sendCriticalAlert({
          description: `Tenant-schema ufuldstændigt (auto-reparation slog fejl): ${t.schemaName}`,
          affectedPath: 'app/api/cron/verify-tenant-schemas/route.ts',
          scanId: `verify-schemas-${t.schemaName}`,
          issueType: 'config_error',
          context: `Manglende kerne-tabeller: ${t.missing.join(', ')}. Berørte features fejler for denne tenant (fx AI-forbrug/billing, audit-log). Undersøg provisionerings-fejl og kør public.provision_tenant_all_features manuelt.`,
        });
      }

      logger.log(
        `[verify-tenant-schemas] checked, fundet ${incomplete.length} ufuldstændige; ` +
          `repareret ${repaired.length}; stadig ufuldstændige ${stillIncomplete.length}`
      );

      return NextResponse.json({
        ok: true,
        foundIncomplete: incomplete.length,
        repaired,
        stillIncomplete: stillIncomplete.map((t) => ({ schema: t.schemaName, missing: t.missing })),
      });
    }
  );
}
