/**
 * Tenant-schema verifikation — lib/tenant/verifyTenantSchema.ts
 *
 * Kontrollerer at et tenant-schema har ALLE forventede kerne-tabeller. Bruges til:
 *   1. Post-provisionerings-tjek i provisionTenantForUser (alarmér hvis en ny bruger
 *      oprettes ufuldstændigt — BIZZ-2196).
 *   2. Periodisk cron-sweep (/api/cron/verify-tenant-schemas) der fanger drift.
 *
 * Bruger Supabase Management API (SUPABASE_ACCESS_TOKEN) til at læse
 * information_schema — samme adgang som selve provisioneringen.
 *
 * @module lib/tenant/verifyTenantSchema
 */

import { logger } from '@/app/lib/logger';

/**
 * De 13 kerne-tabeller som public.provision_tenant_schema skal oprette i HVERT
 * tenant-schema. En manglende tabel betyder at en feature fejler ved brug
 * (fx ai_token_usage → AI-forbrugs-logging/billing; audit_log → audit-skrivninger).
 */
export const EXPECTED_CORE_TENANT_TABLES = [
  'saved_entities',
  'saved_searches',
  'reports',
  'ai_conversations',
  'ai_messages',
  'document_embeddings',
  'audit_log',
  'recent_entities',
  'property_snapshots',
  'notifications',
  'activity_log',
  'support_chat_sessions',
  'ai_token_usage',
] as const;

/** Resultat for ét tenant-schema. */
export interface TenantSchemaStatus {
  schemaName: string;
  /** Kerne-tabeller der mangler (tom = komplet). */
  missing: string[];
}

/** Udled projekt-ref fra NEXT_PUBLIC_SUPABASE_URL. */
function projectRef(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  return url.replace('https://', '').split('.')[0];
}

/**
 * Kør en read-only SQL-query via Management API og returnér rækkerne.
 *
 * @param sql - SELECT-query (kun læsning)
 * @returns Array af rækker, eller null ved fejl
 */
async function mgmtQuery<T = Record<string, unknown>>(sql: string): Promise<T[] | null> {
  const ref = projectRef();
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !accessToken) {
    logger.error('[verifyTenantSchema] mangler projectRef/SUPABASE_ACCESS_TOKEN');
    return null;
  }
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      logger.error('[verifyTenantSchema] mgmt query fejl:', (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? (data as T[]) : [];
  } catch (err) {
    logger.error('[verifyTenantSchema] mgmt query exception:', err);
    return null;
  }
}

/** SQL-liste af de forventede tabeller (escaped). */
function expectedTablesSqlList(): string {
  return EXPECTED_CORE_TENANT_TABLES.map((t) => `'${t}'`).join(',');
}

/**
 * Find manglende kerne-tabeller i ÉT tenant-schema.
 *
 * @param schemaName - Tenant-schemaets navn (fx "tenant_dir_gardian_dk")
 * @returns Liste af manglende tabel-navne, eller null hvis tjekket ikke kunne køres
 */
export async function findMissingTenantTables(schemaName: string): Promise<string[] | null> {
  if (!/^tenant_[a-z0-9_]+$/.test(schemaName)) {
    logger.error(`[verifyTenantSchema] ugyldigt schema-navn: ${schemaName}`);
    return null;
  }
  const rows = await mgmtQuery<{ present: string }>(
    `SELECT table_name AS present FROM information_schema.tables
     WHERE table_schema = '${schemaName}' AND table_name IN (${expectedTablesSqlList()})`
  );
  if (rows === null) return null;
  const present = new Set(rows.map((r) => r.present));
  return EXPECTED_CORE_TENANT_TABLES.filter((t) => !present.has(t));
}

/**
 * Sweep ALLE tenant-schemaer og returnér dem der mangler kerne-tabeller.
 *
 * @returns Liste af ufuldstændige tenants, eller null hvis sweep'et fejlede
 */
export async function findIncompleteTenants(): Promise<TenantSchemaStatus[] | null> {
  const rows = await mgmtQuery<{ schema_name: string; missing: string[] }>(
    `SELECT t.schema_name,
            ARRAY(
              SELECT x FROM unnest(ARRAY[${expectedTablesSqlList()}]) x
              WHERE NOT EXISTS (
                SELECT 1 FROM information_schema.tables it
                WHERE it.table_schema = t.schema_name AND it.table_name = x
              )
            ) AS missing
     FROM public.tenants t
     JOIN information_schema.schemata sc ON sc.schema_name = t.schema_name`
  );
  if (rows === null) return null;
  return rows
    .filter((r) => Array.isArray(r.missing) && r.missing.length > 0)
    .map((r) => ({ schemaName: r.schema_name, missing: r.missing }));
}
