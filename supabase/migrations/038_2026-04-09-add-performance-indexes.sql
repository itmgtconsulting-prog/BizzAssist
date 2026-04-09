-- 038_2026-04-09-add-performance-indexes.sql
-- Add indexes for recent_entities and notifications performance
-- Prevents full table scans at scale (BIZZ-182)

CREATE INDEX IF NOT EXISTS idx_recent_entities_tenant_user_type_visited
  ON tenant.recent_entities (tenant_id, user_id, entity_type, visited_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_read_created
  ON tenant.notifications (tenant_id, is_read, created_at DESC);
