-- ============================================================
-- BIZZ-819 (AI-chat Supabase 2/3): Enable Supabase Realtime publication
-- for ai_chat_messages i alle tenant-schemas, så klienten kan subscribe
-- via BIZZ-820 UI-integration.
--
-- Realtime fungerer via postgres logical replication til publikationen
-- `supabase_realtime`. Tilføjer ai_chat_messages tabellen per tenant-
-- schema. RLS policies fra migration 073 sikrer at kun owner-sessions
-- modtager events.
--
-- Pattern matcher migration 031 (per-tenant DO-loop).
-- ============================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schema_name
    FROM   public.tenants
    WHERE  schema_name IS NOT NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = r.schema_name AND table_name = 'ai_chat_messages'
    ) THEN
      -- Drop eksisterende publikations-indgang hvis den allerede er
      -- tilføjet (idempotent)
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS %I.ai_chat_messages',
        r.schema_name
      );
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime ADD TABLE %I.ai_chat_messages',
        r.schema_name
      );
    END IF;
  END LOOP;
END $$;

-- Fremtidige tenants får publikationen enabled via provision_ai_chat_tables
-- (hvilket vi opdaterer i en senere migration når vi genoverser funktionen).
-- Indtil da: kør denne migration igen efter ny tenant provisioneres.
