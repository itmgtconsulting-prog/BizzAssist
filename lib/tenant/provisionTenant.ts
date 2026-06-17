/**
 * Tenant provisioning helper — lib/tenant/provisionTenant.ts
 *
 * Shared between the public signup flow (app/auth/actions.ts) and the admin
 * user-creation route (app/api/admin/users/route.ts) so that BOTH paths give a
 * new user their OWN dedicated tenant (schema + membership + core tables).
 *
 * BIZZ-1947 follow-up: previously admin-created users were attached to the
 * creating admin's tenant. That both (a) violated tenant isolation — different
 * users could read each other's data — and (b) made the admin DELETE handler
 * destroy a shared tenant when any one member was removed. Every user must have
 * their own tenant; this helper is the single source of truth for that.
 *
 * @module lib/tenant/provisionTenant
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/**
 * Derives the per-tenant Postgres schema name from a user's email.
 * "tenant_" + sanitised email, capped so the full name stays under 60 chars.
 *
 * @param userEmail - The user's email address
 * @returns The schema name (e.g. "tenant_jane_doe_example_com")
 */
export function tenantSchemaName(userEmail: string): string {
  return (
    'tenant_' +
    userEmail
      .replace(/[@.]/g, '_')
      .replace(/[^a-z0-9_]/gi, '')
      .toLowerCase()
      .substring(0, 53)
  );
}

/**
 * Provisions a full, dedicated tenant for a user.
 * Creates: tenant record, membership (tenant_admin), and all core tables
 * (saved_entities, notifications, property_snapshots, recent_entities), exposes
 * the schema to PostgREST, and provisions ALL feature tables (ai_chat,
 * ai_feedback/notification, forsikring chain, vurderingsrapport) via the
 * public.provision_tenant_all_features orchestrator (BIZZ-2165).
 *
 * Idempotent-ish: if the user already has a membership, it is a no-op that
 * returns the existing tenant id (so re-running for an admin-created user that
 * was somehow already provisioned does not create a duplicate).
 *
 * @param userId    - The user's auth.users UUID
 * @param userEmail - Used to derive a unique schema name and tenant name
 * @returns The tenant ID, or null on failure (non-fatal for callers)
 */
export async function provisionTenantForUser(
  userId: string,
  userEmail: string
): Promise<string | null> {
  try {
    const admin = createAdminClient();

    // No-op if the user already belongs to a tenant — prevents duplicates.
    const { data: existing } = await admin
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (existing?.tenant_id) {
      return existing.tenant_id;
    }

    const tenantId = crypto.randomUUID();
    const schemaName = tenantSchemaName(userEmail);

    // 1. Insert tenant row
    const { error: tenantErr } = await admin.from('tenants').insert({
      id: tenantId,
      name: userEmail,
      schema_name: schemaName,
    });
    if (tenantErr) {
      logger.error('[provisionTenant] insert tenant:', tenantErr.message);
      return null;
    }

    // 2. Insert membership
    const { error: memberErr } = await admin.from('tenant_memberships').insert({
      tenant_id: tenantId,
      user_id: userId,
      role: 'tenant_admin',
    });
    if (memberErr) {
      logger.error('[provisionTenant] insert membership:', memberErr.message);
      return null;
    }

    // 3. Create schema + core tables via raw SQL (no pgvector dependency)
    // Uses the service role key which has DDL privileges.
    const sql =
      [
        `CREATE SCHEMA IF NOT EXISTS ${schemaName}`,
        `GRANT USAGE ON SCHEMA ${schemaName} TO authenticated`,
        `GRANT USAGE ON SCHEMA ${schemaName} TO service_role`,

        `CREATE TABLE IF NOT EXISTS ${schemaName}.saved_entities (
        id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
        tenant_id    uuid        NOT NULL DEFAULT '${tenantId}'::uuid,
        entity_type  text        NOT NULL CHECK (entity_type IN ('company','property','person')),
        entity_id    text        NOT NULL,
        entity_data  jsonb       NOT NULL DEFAULT '{}',
        is_monitored boolean     NOT NULL DEFAULT false,
        label        text,
        created_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, entity_type, entity_id)
      )`,
        `ALTER TABLE ${schemaName}.saved_entities ENABLE ROW LEVEL SECURITY`,
        `DROP POLICY IF EXISTS "saved_entities: members read" ON ${schemaName}.saved_entities`,
        `DROP POLICY IF EXISTS "saved_entities: members write" ON ${schemaName}.saved_entities`,
        `CREATE POLICY "saved_entities: members read" ON ${schemaName}.saved_entities FOR SELECT USING (public.is_tenant_member(tenant_id))`,
        `CREATE POLICY "saved_entities: members write" ON ${schemaName}.saved_entities FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))`,

        `CREATE TABLE IF NOT EXISTS ${schemaName}.notifications (
        id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
        tenant_id    uuid        NOT NULL DEFAULT '${tenantId}'::uuid,
        entity_id    text        NOT NULL,
        entity_type  text        NOT NULL DEFAULT 'property' CHECK (entity_type IN ('company','property','person')),
        change_type  text        NOT NULL,
        summary      text        NOT NULL,
        details      jsonb       NOT NULL DEFAULT '{}',
        is_read      boolean     NOT NULL DEFAULT false,
        created_at   timestamptz NOT NULL DEFAULT now()
      )`,
        `ALTER TABLE ${schemaName}.notifications ENABLE ROW LEVEL SECURITY`,
        `DROP POLICY IF EXISTS "notifications: members read" ON ${schemaName}.notifications`,
        `DROP POLICY IF EXISTS "notifications: service write" ON ${schemaName}.notifications`,
        `CREATE POLICY "notifications: members read" ON ${schemaName}.notifications FOR SELECT USING (public.is_tenant_member(tenant_id))`,
        `CREATE POLICY "notifications: service write" ON ${schemaName}.notifications FOR INSERT WITH CHECK (true)`,

        `CREATE TABLE IF NOT EXISTS ${schemaName}.property_snapshots (
        id            uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
        tenant_id     uuid        NOT NULL DEFAULT '${tenantId}'::uuid,
        entity_id     text        NOT NULL,
        snapshot_hash text        NOT NULL,
        snapshot_data jsonb       NOT NULL DEFAULT '{}',
        created_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, entity_id)
      )`,
        `ALTER TABLE ${schemaName}.property_snapshots ENABLE ROW LEVEL SECURITY`,
        `DROP POLICY IF EXISTS "property_snapshots: service read" ON ${schemaName}.property_snapshots`,
        `DROP POLICY IF EXISTS "property_snapshots: service write" ON ${schemaName}.property_snapshots`,
        `CREATE POLICY "property_snapshots: service read" ON ${schemaName}.property_snapshots FOR SELECT USING (true)`,
        `CREATE POLICY "property_snapshots: service write" ON ${schemaName}.property_snapshots FOR ALL USING (true)`,

        `CREATE TABLE IF NOT EXISTS ${schemaName}.recent_entities (
        id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
        tenant_id    uuid        NOT NULL DEFAULT '${tenantId}'::uuid,
        user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        entity_type  text        NOT NULL CHECK (entity_type IN ('company','property','person','search')),
        entity_id    text        NOT NULL,
        display_name text        NOT NULL,
        entity_data  jsonb       NOT NULL DEFAULT '{}',
        visited_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, user_id, entity_type, entity_id)
      )`,
        `ALTER TABLE ${schemaName}.recent_entities ENABLE ROW LEVEL SECURITY`,
        `DROP POLICY IF EXISTS "recent_entities: own read" ON ${schemaName}.recent_entities`,
        `DROP POLICY IF EXISTS "recent_entities: own write" ON ${schemaName}.recent_entities`,
        `DROP POLICY IF EXISTS "recent_entities: own update" ON ${schemaName}.recent_entities`,
        `DROP POLICY IF EXISTS "recent_entities: own delete" ON ${schemaName}.recent_entities`,
        `CREATE POLICY "recent_entities: own read" ON ${schemaName}.recent_entities FOR SELECT USING (user_id = auth.uid() AND public.is_tenant_member(tenant_id))`,
        `CREATE POLICY "recent_entities: own write" ON ${schemaName}.recent_entities FOR INSERT WITH CHECK (user_id = auth.uid() AND public.can_tenant_write(tenant_id))`,
        `CREATE POLICY "recent_entities: own update" ON ${schemaName}.recent_entities FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())`,
        `CREATE POLICY "recent_entities: own delete" ON ${schemaName}.recent_entities FOR DELETE USING (user_id = auth.uid())`,
        `CREATE INDEX IF NOT EXISTS recent_entities_user_idx ON ${schemaName}.recent_entities (user_id, entity_type, visited_at DESC)`,

        `GRANT ALL ON ALL TABLES IN SCHEMA ${schemaName} TO authenticated`,
        `GRANT ALL ON ALL TABLES IN SCHEMA ${schemaName} TO service_role`,
      ].join(';\n') + ';';

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const projectRef = supabaseUrl.replace('https://', '').split('.')[0];
    const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
    if (!accessToken) {
      logger.error('[provisionTenant] SUPABASE_ACCESS_TOKEN not set — skipping DDL');
      return tenantId;
    }

    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error('[provisionTenant] DDL failed:', errText.substring(0, 300));
      // Non-fatal — tenant + membership exist, tables can be created later
    }

    // 4. Expose schema to PostgREST so .schema() queries work (BIZZ-1206).
    // Supabase PostgREST only serves schemas listed in db_schema config.
    // Without this, tenantDb(schemaName) returns 406/500 for all queries.
    try {
      const pgrstRes = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/postgrest`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000),
      });
      if (pgrstRes.ok) {
        const pgrstConfig = (await pgrstRes.json()) as { db_schema: string };
        const schemas = pgrstConfig.db_schema.split(',').map((s: string) => s.trim());
        if (!schemas.includes(schemaName)) {
          schemas.push(schemaName);
          const patchRes = await fetch(
            `https://api.supabase.com/v1/projects/${projectRef}/postgrest`,
            {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ db_schema: schemas.join(',') }),
              signal: AbortSignal.timeout(10000),
            }
          );
          if (!patchRes.ok) {
            logger.error(
              '[provisionTenant] PostgREST schema exposure failed:',
              (await patchRes.text()).substring(0, 300)
            );
          }
        }
      }
    } catch (pgrstErr) {
      logger.error('[provisionTenant] PostgREST config update error:', pgrstErr);
    }

    // 5. Provision ALL feature tables (BIZZ-2165). A single idempotent
    // orchestrator, public.provision_tenant_all_features, creates the full
    // feature-table chain (ai_chat, ai_feedback/notification, the forsikring
    // chain in FK order, and vurderingsrapport). Previously this step only ran
    // provision_ai_chat_tables, so new users were left without forsikring /
    // vurdering tables and could not upload policies (e.g. slj@rtm.dk). The
    // orchestrator wraps each feature in its own exception block so one failing
    // module never blocks the others.
    try {
      const featureSql = `SELECT public.provision_tenant_all_features('${schemaName}', '${tenantId}'::uuid)`;
      const featureRes = await fetch(
        `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: featureSql }),
          signal: AbortSignal.timeout(30000),
        }
      );
      if (!featureRes.ok) {
        logger.error(
          '[provisionTenant] feature provisioning failed:',
          (await featureRes.text()).substring(0, 300)
        );
      }
    } catch (featureErr) {
      logger.error('[provisionTenant] feature provisioning error:', featureErr);
    }

    return tenantId;
  } catch (err) {
    logger.error('[provisionTenant] Unexpected error:', err);
    return null;
  }
}
