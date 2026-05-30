-- BIZZ-1874: Per-bruger session timeout præference
-- Gemmer brugerkonfigurerbar idle-timeout så indstillingen virker cross-device.
-- Retention: data slettes ved konto-sletning (CASCADE via auth.users FK).

CREATE TABLE IF NOT EXISTS public.user_session_preferences (
  user_id         uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  idle_timeout_minutes  int   NOT NULL DEFAULT 60
    CHECK (idle_timeout_minutes BETWEEN 15 AND 480),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Ingen RLS nødvendig — API-laget validerer user_id via auth session.
-- Tabel er i public schema (ikke tenant-schema) da den hører til auth-laget.

COMMENT ON TABLE public.user_session_preferences IS
  'Per-user idle session timeout configuration (BIZZ-1874).';
COMMENT ON COLUMN public.user_session_preferences.idle_timeout_minutes IS
  'Minutes of inactivity before session warning. Range 15-480 (max 8 timer).';
