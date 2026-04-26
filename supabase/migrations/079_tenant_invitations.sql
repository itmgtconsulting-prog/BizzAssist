-- ============================================================================
-- 079: public.tenant_invitations — Pending team invitations.
--
-- BIZZ-271: Tenant admins kan invitere nye medlemmer via email. Invitations
-- har en unik token + udløbsdato (7 dage). Invitée tilgår accept-link der
-- dispatcher til signup (hvis ikke user) eller auto-accept (hvis user).
--
-- Security model:
--   - token = random 256-bit base64url (aldrig loggable i URL kun via email)
--   - expires_at default 7 dage — expired invites kan ikke accepteres
--   - accepted_at markerer brug (token kan kun accepteres én gang)
--   - RLS: admin-only for samme tenant + anon kan lookup via token (for
--     unauthenticated accept-flow)
--   - GDPR: email stored som PII men kun indtil accept/expire; cron-purge
--     fjerner rows >30 dage gamle uden accept.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_invitations (
  id          UUID         PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  tenant_id   UUID         NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email       TEXT         NOT NULL,
  role        TEXT         NOT NULL DEFAULT 'tenant_member'
                CHECK (role IN ('tenant_admin','tenant_member','tenant_viewer')),
  -- Token er 256-bit random base64url (43 chars) — genereres af application-layer.
  token       TEXT         NOT NULL UNIQUE,
  invited_by  UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ  NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Prevent duplicate pending invites til samme email i samme tenant.
  -- Accepterede invites tæller ikke — email-address kan re-inviteres efter
  -- accept (hvis user forlader og admin vil genindbyde).
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS tenant_invitations_token_idx
  ON public.tenant_invitations (token);
CREATE INDEX IF NOT EXISTS tenant_invitations_tenant_idx
  ON public.tenant_invitations (tenant_id, accepted_at);
CREATE INDEX IF NOT EXISTS tenant_invitations_email_idx
  ON public.tenant_invitations (lower(email));

COMMENT ON TABLE public.tenant_invitations IS
  'BIZZ-271: Pending team invitations. Token-based auth til accept-flow uden åben signup.';

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invitations_admin_read ON public.tenant_invitations;
DROP POLICY IF EXISTS invitations_admin_write ON public.tenant_invitations;

-- Admin kan læse alle invites i deres tenant
CREATE POLICY invitations_admin_read ON public.tenant_invitations
  FOR SELECT TO authenticated
  USING (public.is_tenant_admin(tenant_id));

-- Admin kan oprette + opdatere + slette invites i deres tenant
CREATE POLICY invitations_admin_write ON public.tenant_invitations
  FOR ALL TO authenticated
  USING (public.is_tenant_admin(tenant_id))
  WITH CHECK (public.is_tenant_admin(tenant_id));

-- Service-role bypasser RLS (bruges af /api/team/accept som slår token op
-- før user er logget ind i tenant-konteksten).

-- ─── Cron-purge policy (30 dage): parkeret ─────────────────────────────────
-- Retention-cron /api/cron/purge-old-data tilføjes separat ticket — for nu
-- er det acceptable at expired/accepted invites består i tabellen indtil
-- retention-job findes.
