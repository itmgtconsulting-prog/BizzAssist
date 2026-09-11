-- ─────────────────────────────────────────────────────────────────────────
-- 189_property_snapshots_unique_per_type.sql
--
-- Retter unique-constraint på tenant_*.property_snapshots fra
-- (tenant_id, entity_id) til (tenant_id, entity_id, snapshot_type).
--
-- BAGGRUND (BIZZ-2194):
--   poll-properties gemmer ét snapshot PR. type (bbr/ejerskab/...) pr. ejendom
--   og slår op pr. (entity_id, snapshot_type). Men tabellen havde UNIQUE
--   (tenant_id, entity_id) → kun ÉN snapshot-række pr. ejendom. Resultat:
--     1) bbr- og ejerskab-snapshot for samme ejendom kunne ikke sameksistere
--     2) når en ændring blev detekteret, fejlede insert af det nye snapshot
--        (unique-violation, stille slugt) → baseline blev aldrig opdateret →
--        hver kørsel re-detekterede "ændring" og gen-sendte e-mail.
--   Med constraint pr. type kan detectChange() upserte snapshot'et korrekt.
--
-- Folder rettelsen ind i provision_tenant_notify_canonical (mig 188), så den
-- både dækker eksisterende tenants (backfill nedenfor) og nye (kaldes af
-- provision_tenant_all_features). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

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
    EXECUTE format(
      'ALTER TABLE %I.notifications '
      '  ADD COLUMN IF NOT EXISTS user_id           uuid, '
      '  ADD COLUMN IF NOT EXISTS notification_type text, '
      '  ADD COLUMN IF NOT EXISTS title             text, '
      '  ADD COLUMN IF NOT EXISTS message           text, '
      '  ADD COLUMN IF NOT EXISTS metadata          jsonb DEFAULT ''{}''::jsonb, '
      '  ADD COLUMN IF NOT EXISTS is_read           boolean NOT NULL DEFAULT false, '
      '  ADD COLUMN IF NOT EXISTS email_sent_at     timestamptz',
      p_schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.notifications '
      '  DROP COLUMN IF EXISTS change_type, '
      '  DROP COLUMN IF EXISTS summary, '
      '  DROP COLUMN IF EXISTS details, '
      '  DROP COLUMN IF EXISTS body, '
      '  DROP COLUMN IF EXISTS type',
      p_schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.notifications '
      '  ALTER COLUMN user_id           SET NOT NULL, '
      '  ALTER COLUMN notification_type SET NOT NULL, '
      '  ALTER COLUMN title             SET NOT NULL',
      p_schema_name
    );
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = p_schema_name AND table_name = 'notifications'
        AND constraint_type = 'FOREIGN KEY'
        AND constraint_name = 'notifications_user_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.notifications ADD CONSTRAINT notifications_user_id_fkey '
        'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
        p_schema_name
      );
    END IF;
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS notifications_user_read_idx '
      'ON %I.notifications (user_id, is_read, created_at DESC)',
      p_schema_name
    );
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

  -- ── property_snapshots → snapshot_type + unique pr. type ──────────────────
  IF to_regclass(format('%I.property_snapshots', p_schema_name)) IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE %I.property_snapshots '
      '  ADD COLUMN IF NOT EXISTS snapshot_type text NOT NULL DEFAULT ''bbr''',
      p_schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.property_snapshots ALTER COLUMN snapshot_type DROP DEFAULT',
      p_schema_name
    );

    -- BIZZ-2194: Skift unique fra (tenant_id, entity_id) til at inkludere
    -- snapshot_type, så hver type (bbr/ejerskab/...) har sin egen række pr.
    -- ejendom og detectChange() kan upserte korrekt.
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('%I.property_snapshots', p_schema_name)::regclass
        AND conname = 'property_snapshots_tenant_id_entity_id_key'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.property_snapshots '
        'DROP CONSTRAINT property_snapshots_tenant_id_entity_id_key',
        p_schema_name
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('%I.property_snapshots', p_schema_name)::regclass
        AND conname = 'property_snapshots_tenant_entity_type_key'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.property_snapshots '
        'ADD CONSTRAINT property_snapshots_tenant_entity_type_key '
        'UNIQUE (tenant_id, entity_id, snapshot_type)',
        p_schema_name
      );
    END IF;

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

-- ── Backfild alle eksisterende tenant-schemaer ─────────────────────────────
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
    RAISE NOTICE 'property_snapshots unique-fix for % (%)', rec.schema_name, rec.tenant_id;
  END LOOP;
END $$;
