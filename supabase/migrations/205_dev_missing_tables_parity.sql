-- Migration 205: DEV missing-table parity (BIZZ-2197)
-- Replicates 11 tables from PROD (xsyldjqcntiygrtfcszm) that were missing in DEV.
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded constraints/indexes/policies.
-- test/prod already have these tables → IF NOT EXISTS makes this a no-op there.
-- Excludes junk tables tmp_ejerforening_cvr, tinglysning_backfill_probed (per BIZZ-2197 comment).

CREATE TABLE IF NOT EXISTS public.domain_case_entity (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  case_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  entity_name text,
  linked_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sitemap_xml_cache (
  page_id integer NOT NULL,
  xml text NOT NULL,
  entry_count integer DEFAULT 0 NOT NULL,
  generated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.person_cache (
  enheds_nummer bigint NOT NULL,
  roller jsonb,
  ejendomme jsonb,
  fetched_at timestamp with time zone DEFAULT now(),
  stale_after timestamp with time zone DEFAULT (now() + '14 days'::interval)
);

CREATE TABLE IF NOT EXISTS public.tinglysning_adkomst (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  bfe_nummer bigint NOT NULL,
  ejer_navn text,
  ejer_cvr text,
  ejer_type text,
  overtagelsesdato date,
  tinglysningsdato date,
  koebsaftale_dato date,
  kontant_koebesum bigint,
  i_alt_koebesum bigint,
  dokument_id text,
  kilde text DEFAULT 'summarisk'::text,
  fetched_at timestamp with time zone DEFAULT now(),
  boligareal_m2 integer,
  m2_pris integer
);

CREATE TABLE IF NOT EXISTS public.tinglysning_haeftelser (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  bfe_nummer bigint NOT NULL,
  type text,
  kreditor_navn text,
  kreditor_cvr text,
  hovedstol bigint,
  restgaeld bigint,
  valuta text DEFAULT 'DKK'::text,
  rente_pct numeric(6,3),
  tinglysningsdato date,
  dokument_id text,
  kilde text DEFAULT 'summarisk'::text,
  fetched_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tinglysning_servitutter (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  bfe_nummer bigint NOT NULL,
  type text,
  beskrivelse text,
  tinglysningsdato date,
  paategning text,
  dokument_id text,
  kilde text DEFAULT 'summarisk'::text,
  fetched_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tinglysning_dokumenter (
  dokument_id text NOT NULL,
  dokument_type text,
  tinglysningsdato date,
  bfe_nummer bigint,
  parter jsonb,
  beloeb jsonb,
  kilde text DEFAULT 'dokaktuel'::text,
  fetched_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.analyse_datasets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  source text NOT NULL,
  data jsonb DEFAULT '[]'::jsonb NOT NULL,
  columns jsonb DEFAULT '[]'::jsonb NOT NULL,
  row_count integer DEFAULT 0 NOT NULL,
  refreshed_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cvr_enheds_lookup (
  enhedsnummer bigint NOT NULL,
  cvr text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_session_preferences (
  user_id uuid NOT NULL,
  idle_timeout_minutes integer DEFAULT 60 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ejerforening_matrikel_verified (
  candidate_cvr text NOT NULL,
  matrikelnr text NOT NULL,
  ejerlav_kode integer NOT NULL,
  verified_at timestamp with time zone DEFAULT now()
);

-- Constraints (guarded: add only if not already present)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analyse_datasets_source_check' AND conrelid = 'public.analyse_datasets'::regclass) THEN
    ALTER TABLE public.analyse_datasets ADD CONSTRAINT analyse_datasets_source_check CHECK ((source = ANY (ARRAY['ejendomme'::text, 'virksomheder'::text, 'regnskab'::text, 'custom'::text, 'ai_query'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analyse_datasets_user_id_fkey' AND conrelid = 'public.analyse_datasets'::regclass) THEN
    ALTER TABLE public.analyse_datasets ADD CONSTRAINT analyse_datasets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analyse_datasets_pkey' AND conrelid = 'public.analyse_datasets'::regclass) THEN
    ALTER TABLE public.analyse_datasets ADD CONSTRAINT analyse_datasets_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cvr_enheds_lookup_pkey' AND conrelid = 'public.cvr_enheds_lookup'::regclass) THEN
    ALTER TABLE public.cvr_enheds_lookup ADD CONSTRAINT cvr_enheds_lookup_pkey PRIMARY KEY (enhedsnummer);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domain_case_entity_entity_type_check' AND conrelid = 'public.domain_case_entity'::regclass) THEN
    ALTER TABLE public.domain_case_entity ADD CONSTRAINT domain_case_entity_entity_type_check CHECK ((entity_type = ANY (ARRAY['company'::text, 'person'::text, 'property'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domain_case_entity_case_id_fkey' AND conrelid = 'public.domain_case_entity'::regclass) THEN
    ALTER TABLE public.domain_case_entity ADD CONSTRAINT domain_case_entity_case_id_fkey FOREIGN KEY (case_id) REFERENCES domain_case(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domain_case_entity_pkey' AND conrelid = 'public.domain_case_entity'::regclass) THEN
    ALTER TABLE public.domain_case_entity ADD CONSTRAINT domain_case_entity_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domain_case_entity_case_id_entity_type_entity_id_key' AND conrelid = 'public.domain_case_entity'::regclass) THEN
    ALTER TABLE public.domain_case_entity ADD CONSTRAINT domain_case_entity_case_id_entity_type_entity_id_key UNIQUE (case_id, entity_type, entity_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ejerforening_matrikel_verified_pkey' AND conrelid = 'public.ejerforening_matrikel_verified'::regclass) THEN
    ALTER TABLE public.ejerforening_matrikel_verified ADD CONSTRAINT ejerforening_matrikel_verified_pkey PRIMARY KEY (candidate_cvr, matrikelnr, ejerlav_kode);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_cache_pkey' AND conrelid = 'public.person_cache'::regclass) THEN
    ALTER TABLE public.person_cache ADD CONSTRAINT person_cache_pkey PRIMARY KEY (enheds_nummer);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sitemap_xml_cache_pkey' AND conrelid = 'public.sitemap_xml_cache'::regclass) THEN
    ALTER TABLE public.sitemap_xml_cache ADD CONSTRAINT sitemap_xml_cache_pkey PRIMARY KEY (page_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tl_adkomst_bfe' AND conrelid = 'public.tinglysning_adkomst'::regclass) THEN
    ALTER TABLE public.tinglysning_adkomst ADD CONSTRAINT fk_tl_adkomst_bfe FOREIGN KEY (bfe_nummer) REFERENCES bbr_ejendom_status(bfe_nummer) NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tinglysning_adkomst_pkey' AND conrelid = 'public.tinglysning_adkomst'::regclass) THEN
    ALTER TABLE public.tinglysning_adkomst ADD CONSTRAINT tinglysning_adkomst_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tinglysning_dokumenter_pkey' AND conrelid = 'public.tinglysning_dokumenter'::regclass) THEN
    ALTER TABLE public.tinglysning_dokumenter ADD CONSTRAINT tinglysning_dokumenter_pkey PRIMARY KEY (dokument_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tl_haeft_bfe' AND conrelid = 'public.tinglysning_haeftelser'::regclass) THEN
    ALTER TABLE public.tinglysning_haeftelser ADD CONSTRAINT fk_tl_haeft_bfe FOREIGN KEY (bfe_nummer) REFERENCES bbr_ejendom_status(bfe_nummer) NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tinglysning_haeftelser_pkey' AND conrelid = 'public.tinglysning_haeftelser'::regclass) THEN
    ALTER TABLE public.tinglysning_haeftelser ADD CONSTRAINT tinglysning_haeftelser_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tinglysning_servitutter_pkey' AND conrelid = 'public.tinglysning_servitutter'::regclass) THEN
    ALTER TABLE public.tinglysning_servitutter ADD CONSTRAINT tinglysning_servitutter_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_session_preferences_idle_timeout_minutes_check' AND conrelid = 'public.user_session_preferences'::regclass) THEN
    ALTER TABLE public.user_session_preferences ADD CONSTRAINT user_session_preferences_idle_timeout_minutes_check CHECK (((idle_timeout_minutes >= 15) AND (idle_timeout_minutes <= 480)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_session_preferences_user_id_fkey' AND conrelid = 'public.user_session_preferences'::regclass) THEN
    ALTER TABLE public.user_session_preferences ADD CONSTRAINT user_session_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_session_preferences_pkey' AND conrelid = 'public.user_session_preferences'::regclass) THEN
    ALTER TABLE public.user_session_preferences ADD CONSTRAINT user_session_preferences_pkey PRIMARY KEY (user_id);
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_analyse_datasets_user ON public.analyse_datasets USING btree (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cel_cvr ON public.cvr_enheds_lookup USING btree (cvr);
CREATE INDEX IF NOT EXISTS idx_dce_property ON public.domain_case_entity USING btree (entity_id) WHERE (entity_type = 'property'::text);
CREATE INDEX IF NOT EXISTS idx_dce_case_id ON public.domain_case_entity USING btree (case_id);
CREATE INDEX IF NOT EXISTS idx_dce_person ON public.domain_case_entity USING btree (entity_id) WHERE (entity_type = 'person'::text);
CREATE INDEX IF NOT EXISTS idx_dce_company ON public.domain_case_entity USING btree (entity_id) WHERE (entity_type = 'company'::text);
CREATE INDEX IF NOT EXISTS idx_person_cache_stale ON public.person_cache USING btree (stale_after);
CREATE INDEX IF NOT EXISTS idx_tl_adkomst_dato ON public.tinglysning_adkomst USING btree (overtagelsesdato);
CREATE INDEX IF NOT EXISTS idx_tl_adkomst_bfe ON public.tinglysning_adkomst USING btree (bfe_nummer);
CREATE INDEX IF NOT EXISTS idx_tl_adkomst_cvr ON public.tinglysning_adkomst USING btree (ejer_cvr) WHERE (ejer_cvr IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tl_dok_type ON public.tinglysning_dokumenter USING btree (dokument_type);
CREATE INDEX IF NOT EXISTS idx_tl_dok_bfe ON public.tinglysning_dokumenter USING btree (bfe_nummer) WHERE (bfe_nummer IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tl_haeft_kreditor ON public.tinglysning_haeftelser USING btree (kreditor_cvr) WHERE (kreditor_cvr IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tl_haeft_bfe ON public.tinglysning_haeftelser USING btree (bfe_nummer);
CREATE INDEX IF NOT EXISTS idx_tl_servitut_bfe ON public.tinglysning_servitutter USING btree (bfe_nummer);

-- Row Level Security
ALTER TABLE public.domain_case_entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sitemap_xml_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tinglysning_adkomst ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tinglysning_haeftelser ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tinglysning_servitutter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tinglysning_dokumenter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analyse_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cvr_enheds_lookup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_session_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ejerforening_matrikel_verified ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS "analyse_datasets: owner delete" ON public.analyse_datasets;
CREATE POLICY "analyse_datasets: owner delete" ON public.analyse_datasets FOR DELETE TO authenticated
  USING ((user_id = auth.uid()));
DROP POLICY IF EXISTS "analyse_datasets: owner read" ON public.analyse_datasets;
CREATE POLICY "analyse_datasets: owner read" ON public.analyse_datasets FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));
DROP POLICY IF EXISTS "analyse_datasets: service_role full" ON public.analyse_datasets;
CREATE POLICY "analyse_datasets: service_role full" ON public.analyse_datasets FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
DROP POLICY IF EXISTS "read" ON public.cvr_enheds_lookup;
CREATE POLICY "read" ON public.cvr_enheds_lookup FOR SELECT TO public
  USING (true);
DROP POLICY IF EXISTS "write" ON public.cvr_enheds_lookup;
CREATE POLICY "write" ON public.cvr_enheds_lookup FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
DROP POLICY IF EXISTS "dce_delete_member" ON public.domain_case_entity;
CREATE POLICY "dce_delete_member" ON public.domain_case_entity FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM domain_case dc
  WHERE ((dc.id = domain_case_entity.case_id) AND is_domain_member(dc.domain_id)))));
DROP POLICY IF EXISTS "dce_insert_member" ON public.domain_case_entity;
CREATE POLICY "dce_insert_member" ON public.domain_case_entity FOR INSERT TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1
   FROM domain_case dc
  WHERE ((dc.id = domain_case_entity.case_id) AND is_domain_member(dc.domain_id)))));
DROP POLICY IF EXISTS "dce_select_member" ON public.domain_case_entity;
CREATE POLICY "dce_select_member" ON public.domain_case_entity FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM domain_case dc
  WHERE ((dc.id = domain_case_entity.case_id) AND is_domain_member(dc.domain_id)))));
DROP POLICY IF EXISTS "dce_service_all" ON public.domain_case_entity;
CREATE POLICY "dce_service_all" ON public.domain_case_entity FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
DROP POLICY IF EXISTS "person_cache: authenticated read" ON public.person_cache;
CREATE POLICY "person_cache: authenticated read" ON public.person_cache FOR SELECT TO authenticated
  USING (true);
DROP POLICY IF EXISTS "person_cache: service_role full" ON public.person_cache;
CREATE POLICY "person_cache: service_role full" ON public.person_cache FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
DROP POLICY IF EXISTS "sitemap_xml_cache_select_all" ON public.sitemap_xml_cache;
CREATE POLICY "sitemap_xml_cache_select_all" ON public.sitemap_xml_cache FOR SELECT TO anon, authenticated
  USING (true);
DROP POLICY IF EXISTS "tl_adkomst: authenticated read" ON public.tinglysning_adkomst;
CREATE POLICY "tl_adkomst: authenticated read" ON public.tinglysning_adkomst FOR SELECT TO authenticated
  USING (true);
DROP POLICY IF EXISTS "tl_adkomst: service_role full" ON public.tinglysning_adkomst;
CREATE POLICY "tl_adkomst: service_role full" ON public.tinglysning_adkomst FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
DROP POLICY IF EXISTS "tl_dok: authenticated read" ON public.tinglysning_dokumenter;
CREATE POLICY "tl_dok: authenticated read" ON public.tinglysning_dokumenter FOR SELECT TO authenticated
  USING (true);
DROP POLICY IF EXISTS "tl_dok: service_role full" ON public.tinglysning_dokumenter;
CREATE POLICY "tl_dok: service_role full" ON public.tinglysning_dokumenter FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
DROP POLICY IF EXISTS "tl_haeft: authenticated read" ON public.tinglysning_haeftelser;
CREATE POLICY "tl_haeft: authenticated read" ON public.tinglysning_haeftelser FOR SELECT TO authenticated
  USING (true);
DROP POLICY IF EXISTS "tl_haeft: service_role full" ON public.tinglysning_haeftelser;
CREATE POLICY "tl_haeft: service_role full" ON public.tinglysning_haeftelser FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
DROP POLICY IF EXISTS "tl_serv: authenticated read" ON public.tinglysning_servitutter;
CREATE POLICY "tl_serv: authenticated read" ON public.tinglysning_servitutter FOR SELECT TO authenticated
  USING (true);
DROP POLICY IF EXISTS "tl_serv: service_role full" ON public.tinglysning_servitutter;
CREATE POLICY "tl_serv: service_role full" ON public.tinglysning_servitutter FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
