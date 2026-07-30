/**
 * Tenant-provisionerings-paritet (BIZZ-2196/2198/2199) — simulations-test.
 *
 * Regressionen: nye brugere (signup + admin-opret) fik et UFULDSTÆNDIGT
 * tenant-schema fordi provisioneringen ikke kaldte den fulde
 * provision_tenant_schema — 9 kerne-tabeller (ai_token_usage, audit_log m.fl.)
 * manglede, så AI-forbrug/billing, audit-log, AI-chat, rapporter osv. fejlede
 * i stilhed (dir@gardian.dk, slj@rtm.dk).
 *
 * Denne test SIMULERER ny-bruger-provisionering ved at køre den samme
 * orkestrator (public.provision_tenant_all_features) på et engangs-schema og
 * asserterer at ALLE kerne-tabeller oprettes — plus en guard på at ingen
 * eksisterende tenant mangler kerne-tabeller. Browserløs (kun Management API).
 *
 * Kører kun når SUPABASE_ACCESS_TOKEN er sat (skippes ellers, som auth.setup).
 *
 * @module e2e/tenant-provisioning.spec
 */

import { test, expect } from '@playwright/test';

/** De 13 kerne-tabeller provision_tenant_schema skal oprette (spejler lib/tenant/verifyTenantSchema). */
const CORE_TABLES = [
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
];

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
/** Projekt-ref udledes af det env e2e kører mod (selv-oprydende → env-uafhængigt). */
const PROJECT_REF = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')
  .replace('https://', '')
  .split('.')[0];

/** Kør SQL via Supabase Management API. Returnerer rækker. */
async function mgmt<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Management API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []) as T[];
}

const tablesSqlList = CORE_TABLES.map((t) => `'${t}'`).join(',');

test.describe('Tenant-provisionerings-komplethed (BIZZ-2196)', () => {
  test.skip(
    !ACCESS_TOKEN || !PROJECT_REF,
    'kræver SUPABASE_ACCESS_TOKEN + NEXT_PUBLIC_SUPABASE_URL'
  );

  test('frisk provisionering opretter ALLE kerne-tabeller (simulation af ny bruger)', async () => {
    const schema = 'tenant_e2eprovisionsim';
    const tenantId = '00000000-0000-0000-0000-0000000000e2';
    try {
      // Ren start (i tilfælde af tidligere afbrudt kørsel)
      await mgmt(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

      // Simulér ny-bruger-provisionering via samme orkestrator som signup/admin-opret
      await mgmt(`SELECT public.provision_tenant_all_features('${schema}', '${tenantId}'::uuid)`);

      const rows = await mgmt<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = '${schema}' AND table_name IN (${tablesSqlList})`
      );
      const present = new Set(rows.map((r) => r.table_name));
      const missing = CORE_TABLES.filter((t) => !present.has(t));

      expect(
        missing,
        `Kerne-tabeller manglede efter provisionering: ${missing.join(', ')}`
      ).toEqual([]);
    } finally {
      await mgmt(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    }
  });

  test('ingen eksisterende tenant mangler kerne-tabeller', async () => {
    const incomplete = await mgmt<{ schema_name: string; missing: string[] }>(
      `SELECT t.schema_name,
              ARRAY(
                SELECT x FROM unnest(ARRAY[${tablesSqlList}]) x
                WHERE NOT EXISTS (
                  SELECT 1 FROM information_schema.tables it
                  WHERE it.table_schema = t.schema_name AND it.table_name = x
                )
              ) AS missing
       FROM public.tenants t
       JOIN information_schema.schemata sc ON sc.schema_name = t.schema_name
       WHERE ARRAY_LENGTH(ARRAY(
               SELECT x FROM unnest(ARRAY[${tablesSqlList}]) x
               WHERE NOT EXISTS (
                 SELECT 1 FROM information_schema.tables it
                 WHERE it.table_schema = t.schema_name AND it.table_name = x
               )
             ), 1) > 0`
    );
    expect(
      incomplete,
      `Ufuldstændige tenants: ${incomplete.map((i) => `${i.schema_name}(${i.missing.join('/')})`).join(', ')}`
    ).toEqual([]);
  });
});
