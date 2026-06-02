-- Migration 162: user_sessions — single session per device (BIZZ-1875)
-- Tracks active sessions per user + device fingerprint.
-- When a user logs in from a NEW device, all other device sessions are terminated.

CREATE TABLE IF NOT EXISTS public.user_sessions (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id            UUID,
  -- SHA256(device_id_cookie + user_agent) — unique per browser/device
  device_fingerprint   TEXT        NOT NULL,
  -- Human-readable label extracted from User-Agent (e.g. "Chrome 120 on Windows")
  device_label         TEXT,
  -- Client IP address at login time
  ip_address           TEXT,
  last_active          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = session active; set to NOW() when another device logs in
  revoked_at           TIMESTAMPTZ,
  CONSTRAINT user_sessions_user_device UNIQUE (user_id, device_fingerprint)
);

CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx
  ON public.user_sessions(user_id);

CREATE INDEX IF NOT EXISTS user_sessions_active_idx
  ON public.user_sessions(user_id, revoked_at)
  WHERE revoked_at IS NULL;

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read + manage their own sessions
CREATE POLICY "user_sessions_select_own"
  ON public.user_sessions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "user_sessions_insert_own"
  ON public.user_sessions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_sessions_update_own"
  ON public.user_sessions FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "user_sessions_delete_own"
  ON public.user_sessions FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.user_sessions IS
  'Tracks active sessions per user-device fingerprint. Used by BIZZ-1875 to enforce '
  'single-session-per-device: new login from a different device terminates all other sessions.';

COMMENT ON COLUMN public.user_sessions.device_fingerprint IS
  'SHA256 hash of (device_id_cookie + User-Agent). Unique per browser installation.';

COMMENT ON COLUMN public.user_sessions.revoked_at IS
  'NULL = session active. Set to NOW() when another device logs in (or user manually revokes).';
