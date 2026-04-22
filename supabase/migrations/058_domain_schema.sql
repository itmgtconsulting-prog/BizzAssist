-- BIZZ-698: Domain feature schema — 9 tables + RLS + indexes
-- ADR-0005: Domain as parallel entity with owner_tenant_id

-- ─── Enable pgvector if not already ────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── 1. domain ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL,
  owner_tenant_id uuid NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  settings      jsonb NOT NULL DEFAULT '{}',
  plan          text NOT NULL DEFAULT 'enterprise_domain',
  limits        jsonb NOT NULL DEFAULT '{"max_tokens_per_month": 500000, "max_users": 50, "max_templates": 100, "retention_months": 24}',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_domain_slug_unique ON public.domain (slug);

-- ─── 2. domain_member ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain_member (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid NOT NULL REFERENCES public.domain (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  invited_by    uuid,
  invited_at    timestamptz NOT NULL DEFAULT now(),
  joined_at     timestamptz,
  UNIQUE (domain_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_domain_member_user ON public.domain_member (user_id, domain_id);

-- ─── 3. domain_template ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain_template (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid NOT NULL REFERENCES public.domain (id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  file_path     text NOT NULL,
  file_type     text NOT NULL DEFAULT 'docx' CHECK (file_type IN ('docx', 'pdf', 'txt')),
  instructions  text,
  examples      jsonb NOT NULL DEFAULT '[]',
  placeholders  jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version       int NOT NULL DEFAULT 1,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── 4. domain_template_version ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain_template_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES public.domain_template (id) ON DELETE CASCADE,
  version       int NOT NULL,
  file_path     text NOT NULL,
  instructions  text,
  examples      jsonb NOT NULL DEFAULT '[]',
  placeholders  jsonb NOT NULL DEFAULT '[]',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  note          text,
  UNIQUE (template_id, version)
);

-- ─── 5. domain_training_doc ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain_training_doc (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid NOT NULL REFERENCES public.domain (id) ON DELETE CASCADE,
  name          text NOT NULL,
  file_path     text NOT NULL,
  doc_type      text NOT NULL DEFAULT 'guide' CHECK (doc_type IN ('guide', 'policy', 'reference', 'example')),
  description   text,
  extracted_text text,
  tags          text[] NOT NULL DEFAULT '{}',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── 6. domain_case ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain_case (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid NOT NULL REFERENCES public.domain (id) ON DELETE CASCADE,
  name          text NOT NULL,
  client_ref    text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  tags          text[] NOT NULL DEFAULT '{}',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_domain_case_domain ON public.domain_case (domain_id, status);

-- ─── 7. domain_case_doc ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain_case_doc (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES public.domain_case (id) ON DELETE CASCADE,
  name          text NOT NULL,
  file_path     text NOT NULL,
  file_type     text NOT NULL DEFAULT 'pdf' CHECK (file_type IN ('docx', 'pdf', 'txt', 'eml', 'msg')),
  extracted_text text,
  tags          text[] NOT NULL DEFAULT '{}',
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── 8. domain_generation ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain_generation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES public.domain_case (id) ON DELETE CASCADE,
  template_id   uuid NOT NULL REFERENCES public.domain_template (id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  input_doc_ids uuid[] NOT NULL DEFAULT '{}',
  output_path   text,
  claude_tokens int NOT NULL DEFAULT 0,
  user_prompt   text,
  error_message text,
  started_at    timestamptz,
  completed_at  timestamptz,
  requested_by  uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── 9. domain_embedding ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain_embedding (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid NOT NULL REFERENCES public.domain (id) ON DELETE CASCADE,
  source_type   text NOT NULL CHECK (source_type IN ('template', 'training', 'case_doc')),
  source_id     uuid NOT NULL,
  chunk_index   int NOT NULL DEFAULT 0,
  chunk_text    text NOT NULL,
  embedding     vector(1536) NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_domain_embedding_source ON public.domain_embedding (domain_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS ix_domain_embedding_vector ON public.domain_embedding USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ─── 10. domain_audit_log ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.domain_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid NOT NULL REFERENCES public.domain (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  action        text NOT NULL,
  target_type   text,
  target_id     uuid,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_domain_audit_domain ON public.domain_audit_log (domain_id, created_at DESC);

-- ─── RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_training_doc ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_case_doc ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_embedding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_audit_log ENABLE ROW LEVEL SECURITY;

-- ─── SECURITY DEFINER helpers ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_domain_member(p_domain_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.domain_member
    WHERE domain_id = p_domain_id AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_domain_admin(p_domain_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.domain_member
    WHERE domain_id = p_domain_id AND user_id = auth.uid() AND role = 'admin'
  );
$$;

-- ─── RLS Policies ─────────────────────────────────────────────────────────

-- domain: members can read their domains
CREATE POLICY domain_member_read ON public.domain
  FOR SELECT USING (public.is_domain_member(id));

-- domain_member: members can read their domain's members
CREATE POLICY member_read ON public.domain_member
  FOR SELECT USING (public.is_domain_member(domain_id));

-- domain_member: admins can manage members
CREATE POLICY member_admin_all ON public.domain_member
  FOR ALL USING (public.is_domain_admin(domain_id));

-- domain_template: members can read, admins can write
CREATE POLICY template_member_read ON public.domain_template
  FOR SELECT USING (public.is_domain_member(domain_id));
CREATE POLICY template_admin_write ON public.domain_template
  FOR ALL USING (public.is_domain_admin(domain_id));

-- domain_template_version: same as template
CREATE POLICY tpl_version_member_read ON public.domain_template_version
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.domain_template t WHERE t.id = template_id AND public.is_domain_member(t.domain_id))
  );
CREATE POLICY tpl_version_admin_write ON public.domain_template_version
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.domain_template t WHERE t.id = template_id AND public.is_domain_admin(t.domain_id))
  );

-- domain_training_doc: members can read, admins can write
CREATE POLICY training_member_read ON public.domain_training_doc
  FOR SELECT USING (public.is_domain_member(domain_id));
CREATE POLICY training_admin_write ON public.domain_training_doc
  FOR ALL USING (public.is_domain_admin(domain_id));

-- domain_case: members CRUD their own, admins see all
CREATE POLICY case_member_own ON public.domain_case
  FOR ALL USING (public.is_domain_member(domain_id) AND (created_by = auth.uid() OR public.is_domain_admin(domain_id)));

-- domain_case_doc: follows case access
CREATE POLICY case_doc_access ON public.domain_case_doc
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.domain_case c WHERE c.id = case_id AND public.is_domain_member(c.domain_id) AND (c.created_by = auth.uid() OR public.is_domain_admin(c.domain_id)))
  );

-- domain_generation: follows case access
CREATE POLICY generation_access ON public.domain_generation
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.domain_case c WHERE c.id = case_id AND public.is_domain_member(c.domain_id) AND (c.created_by = auth.uid() OR public.is_domain_admin(c.domain_id)))
  );

-- domain_embedding: members can read their domain's embeddings
CREATE POLICY embedding_member_read ON public.domain_embedding
  FOR SELECT USING (public.is_domain_member(domain_id));
CREATE POLICY embedding_admin_write ON public.domain_embedding
  FOR ALL USING (public.is_domain_admin(domain_id));

-- domain_audit_log: members can read, nobody can delete (immutable)
CREATE POLICY audit_member_read ON public.domain_audit_log
  FOR SELECT USING (public.is_domain_member(domain_id));
-- Insert allowed for all members (logged by server-side code via service role)
-- No UPDATE or DELETE policy — audit log is immutable

-- ─── Service role bypass ──────────────────────────────────────────────────
-- Service role (used by API routes) automatically bypasses RLS.
-- No explicit policy needed.
