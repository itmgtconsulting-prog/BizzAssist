-- ============================================================
-- BIZZ-927: Fix provision_tenant_schema to call provision_ai_chat_tables.
--
-- Root cause: migration 073 added provision_ai_chat_tables() and ran it
-- for existing tenants, but never added the call to provision_tenant_schema().
-- New tenants created after migration 073 never got ai_chat_sessions +
-- ai_chat_messages → /api/ai/sessions returns 500 → chat shows
-- "Chat-historik kan ikke gemmes lige nu".
--
-- Fix: Replace provision_tenant_schema to add the missing call.
-- Also: retroactively provision ai_chat_tables for all existing tenants
-- that don't have them yet.
-- ============================================================

-- ─── 1. Patch provision_tenant_schema: add provision_ai_chat_tables call
-- We append the call just before the GRANT block (section 15).
-- Using CREATE OR REPLACE would require the full function body — instead,
-- we wrap the existing function and call provision_ai_chat_tables after it.
-- ============================================================

-- Simpler approach: just ensure all existing tenants get the tables,
-- and add a wrapper trigger for future tenants.

-- ─── 2. Retroactively provision for all existing tenants ─────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT t.id, t.schema_name
    FROM   public.tenants t
    WHERE  t.schema_name IS NOT NULL
      AND  EXISTS (
        SELECT 1 FROM information_schema.schemata s
        WHERE s.schema_name = t.schema_name
      )
      -- Only provision schemas that don't have the table yet
      AND  NOT EXISTS (
        SELECT 1 FROM information_schema.tables it
        WHERE it.table_schema = t.schema_name
          AND it.table_name = 'ai_chat_sessions'
      )
  LOOP
    PERFORM public.provision_ai_chat_tables(r.schema_name, r.id);
    RAISE NOTICE 'Provisioned ai_chat_tables for %', r.schema_name;
  END LOOP;
END $$;

-- ─── 3. Patch provision_tenant_schema to call provision_ai_chat_tables ──
-- We add the call right before the final GRANT section by replacing the
-- function. We extract the existing body and append our call.
-- Safer approach: create a wrapper that calls the original + the new function.

-- Actually, the cleanest fix is to add the call into the function source.
-- Since we can't easily patch PL/pgSQL, we create a trigger on tenants INSERT
-- that auto-provisions ai_chat_tables after provision_tenant_schema runs.

CREATE OR REPLACE FUNCTION public.auto_provision_ai_chat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only run if schema_name is set (provisioned tenant)
  IF NEW.schema_name IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.schemata s
    WHERE s.schema_name = NEW.schema_name
  ) THEN
    PERFORM public.provision_ai_chat_tables(NEW.schema_name, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.auto_provision_ai_chat IS
  'BIZZ-927: Auto-provisions ai_chat_sessions + ai_chat_messages when a new tenant is created or schema_name is updated.';

-- Fire AFTER INSERT/UPDATE so provision_tenant_schema has already created the schema
DROP TRIGGER IF EXISTS trg_auto_provision_ai_chat ON public.tenants;
CREATE TRIGGER trg_auto_provision_ai_chat
  AFTER INSERT OR UPDATE OF schema_name ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_provision_ai_chat();
