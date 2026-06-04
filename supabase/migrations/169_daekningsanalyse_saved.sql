-- BIZZ-2001: Saved coverage analyses
CREATE TABLE IF NOT EXISTS daekningsanalyse_saved (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  thresholds jsonb NOT NULL DEFAULT '{"redMax":20,"greenMin":40}',
  results jsonb NOT NULL DEFAULT '[]',
  file_name text,
  file_path text,
  matrikel_count int NOT NULL DEFAULT 0,
  kunde_count int NOT NULL DEFAULT 0,
  total_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE daekningsanalyse_saved ENABLE ROW LEVEL SECURITY;

-- Users can see their own + same-tenant analyses
CREATE POLICY daekningsanalyse_saved_select ON daekningsanalyse_saved
  FOR SELECT USING (
    user_id = auth.uid()
    OR tenant_id IN (
      SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid()
    )
  );

-- Users can insert their own
CREATE POLICY daekningsanalyse_saved_insert ON daekningsanalyse_saved
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can delete their own
CREATE POLICY daekningsanalyse_saved_delete ON daekningsanalyse_saved
  FOR DELETE USING (user_id = auth.uid());

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_daekningsanalyse_saved_tenant ON daekningsanalyse_saved(tenant_id);
CREATE INDEX IF NOT EXISTS idx_daekningsanalyse_saved_user ON daekningsanalyse_saved(user_id);
