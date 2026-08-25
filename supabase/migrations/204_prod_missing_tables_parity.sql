-- ============================================================
-- Migration 204: prod-tabel-paritet — genskab 5 tabeller der mangler i prod
-- BIZZ-2198.
--
-- PROD mangler 5 tabeller der findes i test/dev (migration-tracking-drift —
-- de originale migrationer 013/029+031/138/162/169 nåede aldrig prod). Mindst
-- én (user_sessions) bruges AKTIVT af app-koden (sessionTracker.ts,
-- /api/auth/sessions) → session-tracking er brudt i prod.
--
-- DDL er rekonstrueret fra den AUTORITATIVE live-tilstand (test for 4 tabeller,
-- dev for user_sessions som kun findes der) — IKKE fra de fragmenterede
-- migration-filer, så senere policy-ændringer (031_rls_fixes) er inkluderet.
-- CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS gør migrationen idempotent
-- (no-op i test/dev der allerede har tabellerne; skaber dem i prod).
--
-- RLS: politikkerne matcher test/dev's nuværende tilstand EKSAKT (data-isolation
-- bevaret). service_role har BYPASSRLS (Supabase) → skrivning sker via API.
-- ============================================================

-- ── 1. verified_links (public) — crowdsourced entity-links ──────────────────
CREATE TABLE IF NOT EXISTS public.verified_links (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text        NOT NULL,
  entity_id     text        NOT NULL,
  entity_name   text        NOT NULL,
  platform      text        NOT NULL,
  url           text        NOT NULL,
  verify_count  integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verified_links_entity_type_check
    CHECK (entity_type = ANY (ARRAY['company'::text, 'person'::text])),
  CONSTRAINT verified_links_entity_type_entity_id_platform_url_key
    UNIQUE (entity_type, entity_id, platform, url)
);
CREATE INDEX IF NOT EXISTS idx_verified_links_entity
  ON public.verified_links (entity_type, entity_id);
ALTER TABLE public.verified_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON public.verified_links;
CREATE POLICY "service_role_only" ON public.verified_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 2. support_chat_abuse (public) — platform-level abuse-lockout ────────────
CREATE TABLE IF NOT EXISTS public.support_chat_abuse (
  user_id            uuid        PRIMARY KEY
                                 REFERENCES auth.users(id) ON DELETE CASCADE,
  violation_count    integer     NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  permanently_locked boolean     NOT NULL DEFAULT false,
  last_violation     timestamptz,
  unlocked_by        uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  unlocked_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.support_chat_abuse ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "support_chat_abuse: read own" ON public.support_chat_abuse;
CREATE POLICY "support_chat_abuse: read own" ON public.support_chat_abuse
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "support_chat_abuse: deny write authenticated" ON public.support_chat_abuse;
CREATE POLICY "support_chat_abuse: deny write authenticated" ON public.support_chat_abuse
  FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "support_chat_abuse: deny update authenticated" ON public.support_chat_abuse;
CREATE POLICY "support_chat_abuse: deny update authenticated" ON public.support_chat_abuse
  FOR UPDATE TO authenticated USING (false);
DROP POLICY IF EXISTS "support_chat_abuse: deny delete authenticated" ON public.support_chat_abuse;
CREATE POLICY "support_chat_abuse: deny delete authenticated" ON public.support_chat_abuse
  FOR DELETE TO authenticated USING (false);

-- ── 3. tinglysning_akt_extraction (public) — AI-ekstraktions-cache ──────────
CREATE TABLE IF NOT EXISTS public.tinglysning_akt_extraction (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bfe_nummer    bigint      NOT NULL,
  akt_navn      text        NOT NULL,
  extraction    jsonb       NOT NULL,
  extracted_at  timestamptz DEFAULT now(),
  CONSTRAINT tinglysning_akt_extraction_bfe_nummer_akt_navn_key
    UNIQUE (bfe_nummer, akt_navn)
);
CREATE INDEX IF NOT EXISTS idx_akt_extraction_bfe
  ON public.tinglysning_akt_extraction (bfe_nummer);
ALTER TABLE public.tinglysning_akt_extraction ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "akt_ext_all" ON public.tinglysning_akt_extraction;
CREATE POLICY "akt_ext_all" ON public.tinglysning_akt_extraction
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "akt_ext_read" ON public.tinglysning_akt_extraction;
CREATE POLICY "akt_ext_read" ON public.tinglysning_akt_extraction
  FOR SELECT TO authenticated USING (true);

-- ── 4. daekningsanalyse_saved (public) — gemte dækningsanalyser ─────────────
CREATE TABLE IF NOT EXISTS public.daekningsanalyse_saved (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name           text        NOT NULL,
  thresholds     jsonb       NOT NULL DEFAULT '{"redMax": 20, "greenMin": 40}'::jsonb,
  results        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  file_name      text,
  file_path      text,
  matrikel_count integer     NOT NULL DEFAULT 0,
  kunde_count    integer     NOT NULL DEFAULT 0,
  total_count    integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daekningsanalyse_saved_tenant
  ON public.daekningsanalyse_saved (tenant_id);
CREATE INDEX IF NOT EXISTS idx_daekningsanalyse_saved_user
  ON public.daekningsanalyse_saved (user_id);
ALTER TABLE public.daekningsanalyse_saved ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS daekningsanalyse_saved_select ON public.daekningsanalyse_saved;
CREATE POLICY daekningsanalyse_saved_select ON public.daekningsanalyse_saved
  FOR SELECT USING (
    user_id = auth.uid()
    OR tenant_id IN (SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid())
  );
DROP POLICY IF EXISTS daekningsanalyse_saved_insert ON public.daekningsanalyse_saved;
CREATE POLICY daekningsanalyse_saved_insert ON public.daekningsanalyse_saved
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS daekningsanalyse_saved_delete ON public.daekningsanalyse_saved;
CREATE POLICY daekningsanalyse_saved_delete ON public.daekningsanalyse_saved
  FOR DELETE USING (user_id = auth.uid());

-- ── 5. user_sessions (public) — single-session-per-device (BIZZ-1875) ───────
--    Bruges aktivt af app-koden → skal findes i prod.
CREATE TABLE IF NOT EXISTS public.user_sessions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id          uuid,
  device_fingerprint text        NOT NULL,
  device_label       text,
  ip_address         text,
  last_active        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  CONSTRAINT user_sessions_user_device UNIQUE (user_id, device_fingerprint)
);
CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx
  ON public.user_sessions (user_id);
CREATE INDEX IF NOT EXISTS user_sessions_active_idx
  ON public.user_sessions (user_id, revoked_at) WHERE revoked_at IS NULL;
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_sessions_select_own" ON public.user_sessions;
CREATE POLICY "user_sessions_select_own" ON public.user_sessions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "user_sessions_insert_own" ON public.user_sessions;
CREATE POLICY "user_sessions_insert_own" ON public.user_sessions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "user_sessions_update_own" ON public.user_sessions;
CREATE POLICY "user_sessions_update_own" ON public.user_sessions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "user_sessions_delete_own" ON public.user_sessions;
CREATE POLICY "user_sessions_delete_own" ON public.user_sessions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
