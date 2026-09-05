-- ─────────────────────────────────────────────────────────────────────────
-- 188_normalize_notifications_snapshots.sql
--
-- Normaliserer tenant_*.notifications og tenant_*.property_snapshots til den
-- kanoniske kontrakt i lib/db/tenant.ts (typerne Notification + PropertySnapshot).
--
-- BAGGRUND (BIZZ-2194):
--   Follow→notifikation-pipelinen var brudt af skema-drift. På tværs af tenants
--   fandtes 3 forskellige notifications-skemaer:
--     A) user_id, entity_id, entity_type, title, body, change_type
--     B) entity_id, entity_type, change_type, summary, details        (ingen user_id)
--     C) user_id, type, title, body, entity_type, metadata
--   Ingen af dem matcher koden, som læser/skriver:
--     user_id, entity_id, entity_type, notification_type, title, message, metadata
--   Reader'en (tenant.ts notifications.list/countUnread) FILTRERER på user_id, så
--   variant B kunne slet ikke vise bruger-scopede notifikationer.
--   property_snapshots manglede desuden snapshot_type i ALLE tenants, selvom
--   poll-properties-cronen + PropertySnapshot-typen kræver den.
--
--   Verificeret 0 rækker i notifications OG property_snapshots i dev/preview/prod
--   på tværs af alle tenants → kolonne-restrukturering (inkl. drop af legacy-
--   kolonner) er fuldstændig tabsfri.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / DROP COLUMN IF EXISTS / CREATE INDEX
-- IF NOT EXISTS — sikker at køre flere gange.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Normaliserings-patch pr. tenant-schema ──────────────────────────────
CREATE OR REPLACE FUNCTION public.provision_tenant_notify_canonical(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- ── notifications → kanonisk skema (kun hvis tabellen findes i schemaet) ──
  IF to_regclass(format('%I.notifications', p_schema_name)) IS NOT NULL THEN
    -- Tilføj kanoniske kolonner (tenant.ts Notification-kontrakt)
    EXECUTE format(
      'ALTER TABLE %I.notifications '
      '  ADD COLUMN IF NOT EXISTS user_id           uuid, '
      '  ADD COLUMN IF NOT EXISTS notification_type text, '
      '  ADD COLUMN IF NOT EXISTS title             text, '
      '  ADD COLUMN IF NOT EXISTS message           text, '
      '  ADD COLUMN IF NOT EXISTS metadata          jsonb DEFAULT ''{}''::jsonb, '
      '  ADD COLUMN IF NOT EXISTS is_read           boolean NOT NULL DEFAULT false, '
      -- email_sent_at: sat når notify-followers-cronen har afsendt e-mail om
      -- denne ændring. NULL = ikke afsendt endnu → idempotent afsendelse.
      '  ADD COLUMN IF NOT EXISTS email_sent_at     timestamptz',
      p_schema_name
    );

    -- Fjern legacy-kolonner fra de gamle skema-varianter A/B/C (0 rækker → tabsfrit)
    EXECUTE format(
      'ALTER TABLE %I.notifications '
      '  DROP COLUMN IF EXISTS change_type, '
      '  DROP COLUMN IF EXISTS summary, '
      '  DROP COLUMN IF EXISTS details, '
      '  DROP COLUMN IF EXISTS body, '
      '  DROP COLUMN IF EXISTS type',
      p_schema_name
    );

    -- NOT NULL på de obligatoriske felter (tabel er tom → sikkert)
    EXECUTE format(
      'ALTER TABLE %I.notifications '
      '  ALTER COLUMN user_id           SET NOT NULL, '
      '  ALTER COLUMN notification_type SET NOT NULL, '
      '  ALTER COLUMN title             SET NOT NULL',
      p_schema_name
    );

    -- FK user_id → auth.users (cascade-delete, så GDPR-sletning rydder notifikationer)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = p_schema_name
        AND table_name = 'notifications'
        AND constraint_type = 'FOREIGN KEY'
        AND constraint_name = 'notifications_user_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.notifications '
        '  ADD CONSTRAINT notifications_user_id_fkey '
        '  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
        p_schema_name
      );
    END IF;

    -- Indeks til reader-queries: ulæste pr. bruger, nyeste først
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS notifications_user_read_idx '
      'ON %I.notifications (user_id, is_read, created_at DESC)',
      p_schema_name
    );

    -- Partielt indeks til notify-followers-cronen: kun endnu-ikke-afsendte
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS notifications_email_pending_idx '
      'ON %I.notifications (created_at) WHERE email_sent_at IS NULL',
      p_schema_name
    );

    EXECUTE format(
      'GRANT ALL ON %I.notifications TO authenticated, service_role',
      p_schema_name
    );
  END IF;

  -- ── property_snapshots → tilføj snapshot_type (kun hvis tabellen findes) ──
  IF to_regclass(format('%I.property_snapshots', p_schema_name)) IS NOT NULL THEN
    -- snapshot_type kræves af poll-properties + PropertySnapshot-typen
    EXECUTE format(
      'ALTER TABLE %I.property_snapshots '
      '  ADD COLUMN IF NOT EXISTS snapshot_type text NOT NULL DEFAULT ''bbr''',
      p_schema_name
    );
    -- Fjern default igen, så fremtidige inserts er eksplicitte (NOT NULL bevares)
    EXECUTE format(
      'ALTER TABLE %I.property_snapshots ALTER COLUMN snapshot_type DROP DEFAULT',
      p_schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS property_snapshots_entity_type_idx '
      'ON %I.property_snapshots (entity_id, snapshot_type, created_at DESC)',
      p_schema_name
    );
    EXECUTE format(
      'GRANT ALL ON %I.property_snapshots TO authenticated, service_role',
      p_schema_name
    );
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.provision_tenant_notify_canonical(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_notify_canonical(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_notify_canonical(text, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.provision_tenant_notify_canonical(text, uuid) TO service_role;

COMMENT ON FUNCTION public.provision_tenant_notify_canonical(text, uuid) IS
  'BIZZ-2194: Idempotent normalisering af tenant notifications + property_snapshots '
  'til den kanoniske kontrakt i lib/db/tenant.ts. Kaldes af provision_tenant_all_features '
  'for nye tenants og af backfill-loopet nedenfor for eksisterende.';

-- ── 2. Hook normaliseringen ind i orchestratoren (nye tenants) ─────────────
--    Genskaber provision_tenant_all_features (mig 183) uændret + ét nyt step.
CREATE OR REPLACE FUNCTION public.provision_tenant_all_features(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- AI chat (mig 073)
  BEGIN PERFORM public.provision_ai_chat_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features ai_chat %: %', p_schema_name, SQLERRM; END;

  -- AI feedback/notification (mig 051)
  BEGIN PERFORM public.provision_tenant_ai_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features ai_tables %: %', p_schema_name, SQLERRM; END;

  -- TTL-indekser (mig 024)
  BEGIN PERFORM public.provision_tenant_schema_ttl_patch(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features ttl %: %', p_schema_name, SQLERRM; END;

  -- BIZZ-2194: Normalisér notifications + property_snapshots til kanonisk skema
  BEGIN PERFORM public.provision_tenant_notify_canonical(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features notify_canonical %: %', p_schema_name, SQLERRM; END;

  -- Forsikring-kæde i FK-rækkefølge: tables → analyser → kunde_id → sager → analyse_documents → gaps_fk → user_scope
  BEGIN PERFORM public.provision_tenant_forsikring_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_tables %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_analyser_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_analyser %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_kunde_id(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_kunde_id %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_sager(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_sager %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_analyse_documents(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_analyse_docs %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_gaps_analyse_fk(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_gaps_fk %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_forsikring_user_scope(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_user_scope %: %', p_schema_name, SQLERRM; END;

  -- Vurderingsrapport (mig 146)
  BEGIN PERFORM public.provision_tenant_vurdering_sager(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features vurdering %: %', p_schema_name, SQLERRM; END;

  -- KRITISK (BIZZ-2165): SECURITY DEFINER-funktionerne opretter tabeller ejet af
  -- function-owneren (postgres). PostgREST forbinder som authenticator og skifter
  -- til service_role/authenticated, der har brug for eksplicit GRANT — ellers
  -- fejler enhver .schema(...).from(...) med 42501 "permission denied for table".
  -- Base-provisioneringen GRANT'er kun de tabeller der fandtes paa det tidspunkt,
  -- saa feature-tabeller skabt her SKAL grantes til sidst. Uden dette kunne nye
  -- brugere ikke uploade policer (slj@rtm.dk: forsikring_documents 42501).
  BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated, service_role', p_schema_name);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO authenticated, service_role', p_schema_name);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO authenticated, service_role', p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features grants %: %', p_schema_name, SQLERRM; END;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.provision_tenant_all_features(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_all_features(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_all_features(text, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.provision_tenant_all_features(text, uuid) TO service_role;

-- ── 3. Backfild ALLE eksisterende tenant-schemaer ──────────────────────────
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT t.schema_name, t.id AS tenant_id
    FROM public.tenants t
    WHERE t.schema_name LIKE 'tenant\_%' ESCAPE '\'
      AND EXISTS (
        SELECT 1 FROM information_schema.schemata s
        WHERE s.schema_name = t.schema_name
      )
  LOOP
    PERFORM public.provision_tenant_notify_canonical(rec.schema_name, rec.tenant_id);
    RAISE NOTICE 'Normaliseret notifications+property_snapshots for % (%)', rec.schema_name, rec.tenant_id;
  END LOOP;
END $$;
