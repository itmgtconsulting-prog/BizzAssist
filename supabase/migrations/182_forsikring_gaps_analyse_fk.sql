-- ============================================================
-- Migration 182: FK med ON DELETE CASCADE på forsikring_gaps.analyse_id (BIZZ-2159)
-- ============================================================
-- Rod-årsag: Migration 112 tilføjede analyse_id til forsikring_gaps via
-- ADD COLUMN uden foreign key. forsikring_aktiver har CASCADE på analyse_id,
-- men gaps havde ingen — så når en analyse slettes (cascade rydder aktiver)
-- efterlades gap-rækker forældreløse. Auditen fandt 162 forældreløse gaps
-- i tenant_jjrchefen_gmail_com.
--
-- Denne migration:
--   1. Sletter eksisterende forældreløse gaps i alle tenant-schemas.
--   2. Tilføjer FK forsikring_gaps_analyse_id_fkey med ON DELETE CASCADE.
-- ============================================================

CREATE OR REPLACE FUNCTION public.provision_tenant_forsikring_gaps_analyse_fk(
  p_schema_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- ─── 1. Ryd forældreløse gaps (analyse_id peger på ikke-eksisterende analyse) ─
  EXECUTE format(
    'DELETE FROM %I.forsikring_gaps g '
    'WHERE g.analyse_id IS NOT NULL '
    'AND NOT EXISTS (SELECT 1 FROM %I.forsikring_analyser an WHERE an.id = g.analyse_id)',
    p_schema_name, p_schema_name
  );

  -- ─── 2. Tilføj FK med ON DELETE CASCADE (idempotent) ─
  EXECUTE format(
    'DO $body$ BEGIN '
    'IF NOT EXISTS ('
    '  SELECT 1 FROM information_schema.table_constraints'
    '  WHERE table_schema = %L AND table_name = ''forsikring_gaps'''
    '    AND constraint_name = ''forsikring_gaps_analyse_id_fkey'''
    ') THEN '
    '  ALTER TABLE %I.forsikring_gaps '
    '    ADD CONSTRAINT forsikring_gaps_analyse_id_fkey '
    '    FOREIGN KEY (analyse_id) REFERENCES %I.forsikring_analyser(id) ON DELETE CASCADE; '
    'END IF; END $body$;',
    p_schema_name, p_schema_name, p_schema_name
  );
END;
$$;

-- Anvend på alle tenant-schemas med forsikring_gaps-tabel
DO $$
DECLARE
  schema_rec record;
BEGIN
  FOR schema_rec IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant\_%' ESCAPE '\'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = schema_rec.schema_name AND table_name = 'forsikring_gaps'
    ) THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = schema_rec.schema_name AND table_name = 'forsikring_analyser'
    ) THEN CONTINUE; END IF;
    PERFORM public.provision_tenant_forsikring_gaps_analyse_fk(schema_rec.schema_name);
    RAISE NOTICE 'Added forsikring_gaps analyse FK for %', schema_rec.schema_name;
  END LOOP;
END $$;
