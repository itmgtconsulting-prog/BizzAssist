-- ============================================================
-- Migration 147: Provision vurdering_sager for existing tenants (BIZZ-1661)
-- ============================================================
-- Migration 146 created the provision function but never called it.
-- This migration retroactively provisions all existing tenant schemas.
-- Idempotent via CREATE TABLE IF NOT EXISTS inside the function.
-- ============================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schema_name, id AS tenant_id
    FROM public.tenants
    WHERE schema_name IS NOT NULL
  LOOP
    PERFORM public.provision_tenant_vurdering_sager(r.schema_name, r.tenant_id);
    RAISE NOTICE 'Provisioned vurdering tables for tenant % (schema %)', r.tenant_id, r.schema_name;
  END LOOP;
END;
$$;
