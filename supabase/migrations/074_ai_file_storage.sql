-- ============================================================
-- BIZZ-810 (AI DocGen 1/8): Storage-infra for AI-genererede + bruger-
-- vedhæftede filer.
--
-- Pipeline-kontekst: /api/ai/attach modtager filer fra chatten (templates,
-- reference-materiale). /api/ai/generate-file producerer output (XLSX/CSV/
-- DOCX) fra Claude tool-use. Begge skal persistere binær midlertidigt
-- (max 24 timer) så chat-turns kan referere tidligere uploads/outputs
-- OG så brugeren kan downloade resultatet. Efter TTL: slettes automatisk
-- af /api/cron/purge-ai-files.
--
-- Storage-design:
--   * ai-attachments bucket (private, max 50MB): brugerens uploadede
--     templates/reference-filer under chat
--   * ai-generated bucket (private, max 10MB): AI-producerede outputs
--   * ai_file tabel: metadata + expires_at for TTL-tracking
--
-- GDPR Art. 5(1)(c) — data minimisation: 24t TTL på alle filer.
-- Art. 17 — right to erasure: ON DELETE CASCADE fra auth.users.
-- Art. 32 — security: private buckets + signed URLs + RLS på metadata.
-- ============================================================

-- ─── Buckets ─────────────────────────────────────────────────
-- Supabase buckets oprettes via storage.buckets-tabellen. ON CONFLICT
-- DO NOTHING sikrer idempotens hvis migration kører to gange.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'ai-attachments',
    'ai-attachments',
    false,
    52428800, -- 50 MB
    NULL      -- accept alle MIME-typer; validering sker i /api/ai/attach
  ),
  (
    'ai-generated',
    'ai-generated',
    false,
    10485760, -- 10 MB
    ARRAY[
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/csv',
      'application/pdf',
      'text/plain'
    ]
  )
ON CONFLICT (id) DO NOTHING;

-- ─── Storage policies ────────────────────────────────────────
-- Private buckets: kun service_role må INSERT/UPDATE/DELETE. Reads sker
-- altid via signed URL genereret server-side (aldrig direct).

DROP POLICY IF EXISTS "ai-attachments: service_role only" ON storage.objects;
CREATE POLICY "ai-attachments: service_role only" ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'ai-attachments')
  WITH CHECK (bucket_id = 'ai-attachments');

DROP POLICY IF EXISTS "ai-generated: service_role only" ON storage.objects;
CREATE POLICY "ai-generated: service_role only" ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'ai-generated')
  WITH CHECK (bucket_id = 'ai-generated');

-- ─── ai_file tabel ───────────────────────────────────────────
-- Shared public-schema tabel (user-scoped via RLS, ikke tenant-scoped).
-- Indexes optimeret for cron-scan (expires_at) + user-pagination
-- (user_id, kind, created_at).

CREATE TABLE IF NOT EXISTS public.ai_file (
  id           UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('attachment','generated')),
  -- Valgfri link til chat-konversation så /api/ai/chat kan filtere
  -- "files for this conversation".
  conv_id      TEXT,
  file_path    TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  file_type    TEXT,
  size_bytes   BIGINT,
  -- Fri metadata (fx tool-output-params, original-upload-info).
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE public.ai_file IS
  'BIZZ-810: Metadata for AI-flow-filer (attachments + generated). TTL via expires_at, purge via /api/cron/purge-ai-files.';

-- Cron-scan: alle rækker med expires_at < now()
CREATE INDEX IF NOT EXISTS idx_ai_file_expires
  ON public.ai_file (expires_at);

-- User-listing: "mine AI-filer per type/konversation"
CREATE INDEX IF NOT EXISTS idx_ai_file_user_kind
  ON public.ai_file (user_id, kind, created_at DESC);

-- Conv-join: "alle filer i denne chat"
CREATE INDEX IF NOT EXISTS idx_ai_file_conv
  ON public.ai_file (conv_id)
  WHERE conv_id IS NOT NULL;

-- ─── RLS ─────────────────────────────────────────────────────
ALTER TABLE public.ai_file ENABLE ROW LEVEL SECURITY;

-- Users kan læse egne rows (e.g. vis "mine genererede filer"-liste)
DROP POLICY IF EXISTS "ai_file: owner read" ON public.ai_file;
CREATE POLICY "ai_file: owner read" ON public.ai_file
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Users kan slette egne rows (manuel cleanup før TTL)
DROP POLICY IF EXISTS "ai_file: owner delete" ON public.ai_file;
CREATE POLICY "ai_file: owner delete" ON public.ai_file
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Service-role har fuld adgang (alt skriveri sker via server-side API)
DROP POLICY IF EXISTS "ai_file: service write" ON public.ai_file;
CREATE POLICY "ai_file: service write" ON public.ai_file
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ─── Privileges ──────────────────────────────────────────────
GRANT SELECT, DELETE ON public.ai_file TO authenticated;
GRANT ALL ON public.ai_file TO service_role;
