-- Migration 211: reconcile per-tenant skema-drift (BIZZ-2199)
--
-- Paritets-gaten (BIZZ-2196) + review afslørede at 5 prod-tenant-skemaer stod på
-- en ÆLDRE variant af ai_conversations/ai_messages/document_embeddings og manglede
-- de kanoniske kolonner som de øvrige 22 har. Desuden manglede ét gammelt skema
-- (tenant_annaxianh_gmail_com) hele ai_chat_messages-tabellen.
--
-- Denne reconcile er RENT ADDITIV — ADD COLUMN IF NOT EXISTS + CREATE TABLE IF
-- NOT EXISTS — så der er intet datatab (og ingen tabel-kopier nødvendige;
-- reversibel via DROP). Kolonner der er NOT NULL uden default i templaten
-- tilføjes NULLABLE her for ikke at fejle på eksisterende rækker; kolonne-
-- EKSISTENS er det driften handler om. Gamle extra-kolonner (tenant_id/
-- tokens_used/source_id/source_type/reports.entity_type/is_exported) efterlades
-- urørt (harmløse; at droppe dem ville være datatab-risiko).
--
-- Idempotent + køres i alle 3 miljøer. Bringer alle tenant_*-skemaer til
-- kanonisk template for disse tabeller.

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%' LOOP
    -- ai_conversations
    IF to_regclass(format('%I.ai_conversations', s)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.ai_conversations ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT ''{}''::jsonb', s);
    END IF;
    -- ai_messages
    IF to_regclass(format('%I.ai_messages', s)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.ai_messages ADD COLUMN IF NOT EXISTS token_count integer', s);
      EXECUTE format('ALTER TABLE %I.ai_messages ADD COLUMN IF NOT EXISTS tool_calls jsonb', s);
    END IF;
    -- document_embeddings
    IF to_regclass(format('%I.document_embeddings', s)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.document_embeddings ADD COLUMN IF NOT EXISTS entity_id text', s);
      EXECUTE format('ALTER TABLE %I.document_embeddings ADD COLUMN IF NOT EXISTS entity_type text', s);
    END IF;
    -- ai_chat_messages: opret hvis den mangler (kun tenant_annaxianh_gmail_com i prod).
    -- Uden FK til ai_chat_sessions for ikke at fejle hvis den tabel også mangler i
    -- et gammelt skema; PK + role-CHECK bevares.
    IF to_regclass(format('%I.ai_chat_messages', s)) IS NULL THEN
      EXECUTE format($f$
        CREATE TABLE %I.ai_chat_messages (
          id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
          session_id  uuid NOT NULL,
          role        text NOT NULL CHECK (role = ANY (ARRAY['user','assistant','system','tool'])),
          content     jsonb NOT NULL,
          tokens_in   integer,
          tokens_out  integer,
          model       text,
          tool_calls  jsonb,
          created_at  timestamptz NOT NULL DEFAULT now()
        )$f$, s);
    END IF;
  END LOOP;
END $$;
