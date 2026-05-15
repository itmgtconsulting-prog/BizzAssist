-- ============================================================================
-- 127: Foreign keys mellem kernetabeller — BIZZ-1480
-- Tilføjer FK constraints for dataintegritet. NOT VALID = skip existing
-- row validation (idempotent, hurtigt).
-- ============================================================================

-- ejf_ejerskab → bbr_ejendom_status (kan have orphans — NOT VALID)
DO $$ BEGIN
  ALTER TABLE public.ejf_ejerskab
    ADD CONSTRAINT fk_ejf_bfe FOREIGN KEY (bfe_nummer)
    REFERENCES public.bbr_ejendom_status(bfe_nummer) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- vurdering_cache → bbr_ejendom_status
DO $$ BEGIN
  ALTER TABLE public.vurdering_cache
    ADD CONSTRAINT fk_vur_bfe FOREIGN KEY (bfe_nummer)
    REFERENCES public.bbr_ejendom_status(bfe_nummer) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ejerskifte_historik → bbr_ejendom_status
DO $$ BEGIN
  ALTER TABLE public.ejerskifte_historik
    ADD CONSTRAINT fk_ejerskifte_bfe FOREIGN KEY (bfe_nummer)
    REFERENCES public.bbr_ejendom_status(bfe_nummer) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- tinglysning_adkomst → bbr_ejendom_status
DO $$ BEGIN
  ALTER TABLE public.tinglysning_adkomst
    ADD CONSTRAINT fk_tl_adkomst_bfe FOREIGN KEY (bfe_nummer)
    REFERENCES public.bbr_ejendom_status(bfe_nummer) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- tinglysning_haeftelser → bbr_ejendom_status
DO $$ BEGIN
  ALTER TABLE public.tinglysning_haeftelser
    ADD CONSTRAINT fk_tl_haeft_bfe FOREIGN KEY (bfe_nummer)
    REFERENCES public.bbr_ejendom_status(bfe_nummer) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- cvr_virksomhed_ejerskab → cvr_virksomhed (ejer-side)
DO $$ BEGIN
  ALTER TABLE public.cvr_virksomhed_ejerskab
    ADD CONSTRAINT fk_cvr_ejerskab_ejer FOREIGN KEY (ejer_cvr)
    REFERENCES public.cvr_virksomhed(cvr) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- cvr_virksomhed_ejerskab → cvr_virksomhed (ejet-side)
DO $$ BEGIN
  ALTER TABLE public.cvr_virksomhed_ejerskab
    ADD CONSTRAINT fk_cvr_ejerskab_ejet FOREIGN KEY (ejet_cvr)
    REFERENCES public.cvr_virksomhed(cvr) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON CONSTRAINT fk_ejf_bfe ON public.ejf_ejerskab IS 'BIZZ-1480: FK til bbr_ejendom_status (NOT VALID — orphans tilladt)';
