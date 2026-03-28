-- ============================================================
-- Migration 005: Fix provision_tenant_schema idempotency + security
-- BizzAssist — BIZZ-9 patch
-- ============================================================
-- Replaces provision_tenant_schema() with a fully idempotent version:
--   • DROP POLICY IF EXISTS before every CREATE POLICY
--   • DROP TRIGGER IF EXISTS before every CREATE TRIGGER
--   • Table / schema / index creation already uses IF NOT EXISTS
--
-- Also locks down execute permissions:
--   • REVOKE execute from PUBLIC (was world-callable by default)
--   • GRANT execute only to service_role and postgres (admin operations)
--
-- ISO 27001 A.9 (Access Control) — provisioning must only be
-- callable by the service role, never by authenticated/anon users.
-- ============================================================

create or replace function public.provision_tenant_schema(
  p_schema_name text,
  p_tenant_id   uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $OUTER$
begin

  -- ── 1. Schema ─────────────────────────────────────────────

  execute format('create schema if not exists %I', p_schema_name);
  execute format('grant usage on schema %I to authenticated', p_schema_name);
  execute format('grant usage on schema %I to service_role',  p_schema_name);


  -- ── 2. saved_entities ────────────────────────────────────

  execute format(
    'create table if not exists %I.saved_entities ('
    '  id           uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        not null default %L::uuid,'
    '  entity_type  text        not null check (entity_type in (''company'',''property'',''person'')),'
    '  entity_id    text        not null,'
    '  entity_data  jsonb       not null default ''{}''::jsonb,'
    '  is_monitored boolean     not null default false,'
    '  label        text,'
    '  created_by   uuid        not null references auth.users(id) on delete set null,'
    '  created_at   timestamptz not null default now(),'
    '  updated_at   timestamptz not null default now(),'
    '  unique (tenant_id, entity_type, entity_id)'
    ')',
    p_schema_name, p_tenant_id
  );
  execute format('alter table %I.saved_entities enable row level security', p_schema_name);

  execute format('drop policy if exists "saved_entities: members read"   on %I.saved_entities', p_schema_name);
  execute format('drop policy if exists "saved_entities: members write"  on %I.saved_entities', p_schema_name);
  execute format('drop policy if exists "saved_entities: members update" on %I.saved_entities', p_schema_name);
  execute format('drop policy if exists "saved_entities: admin delete"   on %I.saved_entities', p_schema_name);

  execute format('create policy "saved_entities: members read"   on %I.saved_entities for select using (public.is_tenant_member(tenant_id))', p_schema_name);
  execute format('create policy "saved_entities: members write"  on %I.saved_entities for insert with check (public.can_tenant_write(tenant_id))', p_schema_name);
  execute format('create policy "saved_entities: members update" on %I.saved_entities for update using (public.can_tenant_write(tenant_id)) with check (public.can_tenant_write(tenant_id))', p_schema_name);
  execute format('create policy "saved_entities: admin delete"   on %I.saved_entities for delete using (public.is_tenant_admin(tenant_id))', p_schema_name);

  execute format('drop trigger if exists saved_entities_updated_at on %I.saved_entities', p_schema_name);
  execute format('create trigger saved_entities_updated_at before update on %I.saved_entities for each row execute procedure public.set_updated_at()', p_schema_name);


  -- ── 3. saved_searches ────────────────────────────────────

  execute format(
    'create table if not exists %I.saved_searches ('
    '  id           uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        not null default %L::uuid,'
    '  query        text        not null,'
    '  filters      jsonb       not null default ''{}''::jsonb,'
    '  entity_type  text        not null default ''all'' check (entity_type in (''company'',''property'',''person'',''all'')),'
    '  result_count integer,'
    '  created_by   uuid        not null references auth.users(id) on delete set null,'
    '  created_at   timestamptz not null default now()'
    ')',
    p_schema_name, p_tenant_id
  );
  execute format('alter table %I.saved_searches enable row level security', p_schema_name);

  execute format('drop policy if exists "saved_searches: members read"  on %I.saved_searches', p_schema_name);
  execute format('drop policy if exists "saved_searches: members write" on %I.saved_searches', p_schema_name);
  execute format('drop policy if exists "saved_searches: admin delete"  on %I.saved_searches', p_schema_name);

  execute format('create policy "saved_searches: members read"  on %I.saved_searches for select using (public.is_tenant_member(tenant_id))', p_schema_name);
  execute format('create policy "saved_searches: members write" on %I.saved_searches for insert with check (public.can_tenant_write(tenant_id))', p_schema_name);
  execute format('create policy "saved_searches: admin delete"  on %I.saved_searches for delete using (public.is_tenant_admin(tenant_id))', p_schema_name);


  -- ── 4. reports ───────────────────────────────────────────

  execute format(
    'create table if not exists %I.reports ('
    '  id           uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        not null default %L::uuid,'
    '  title        text        not null,'
    '  report_type  text        not null check (report_type in (''company_analysis'',''property_report'',''person_report'',''market_overview'',''custom'')),'
    '  entity_type  text        check (entity_type in (''company'',''property'',''person'')),'
    '  entity_id    text,'
    '  content      jsonb       not null default ''{}''::jsonb,'
    '  is_exported  boolean     not null default false,'
    '  created_by   uuid        not null references auth.users(id) on delete set null,'
    '  created_at   timestamptz not null default now(),'
    '  updated_at   timestamptz not null default now()'
    ')',
    p_schema_name, p_tenant_id
  );
  execute format('alter table %I.reports enable row level security', p_schema_name);

  execute format('drop policy if exists "reports: members read"   on %I.reports', p_schema_name);
  execute format('drop policy if exists "reports: members write"  on %I.reports', p_schema_name);
  execute format('drop policy if exists "reports: members update" on %I.reports', p_schema_name);
  execute format('drop policy if exists "reports: admin delete"   on %I.reports', p_schema_name);

  execute format('create policy "reports: members read"   on %I.reports for select using (public.is_tenant_member(tenant_id))', p_schema_name);
  execute format('create policy "reports: members write"  on %I.reports for insert with check (public.can_tenant_write(tenant_id))', p_schema_name);
  execute format('create policy "reports: members update" on %I.reports for update using (public.can_tenant_write(tenant_id)) with check (public.can_tenant_write(tenant_id))', p_schema_name);
  execute format('create policy "reports: admin delete"   on %I.reports for delete using (public.is_tenant_admin(tenant_id))', p_schema_name);

  execute format('drop trigger if exists reports_updated_at on %I.reports', p_schema_name);
  execute format('create trigger reports_updated_at before update on %I.reports for each row execute procedure public.set_updated_at()', p_schema_name);


  -- ── 5. ai_conversations ──────────────────────────────────

  execute format(
    'create table if not exists %I.ai_conversations ('
    '  id           uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        not null default %L::uuid,'
    '  title        text,'
    '  is_shared    boolean     not null default false,'
    '  created_by   uuid        not null references auth.users(id) on delete set null,'
    '  created_at   timestamptz not null default now(),'
    '  updated_at   timestamptz not null default now()'
    ')',
    p_schema_name, p_tenant_id
  );
  execute format('alter table %I.ai_conversations enable row level security', p_schema_name);

  execute format('drop policy if exists "ai_conversations: members read"  on %I.ai_conversations', p_schema_name);
  execute format('drop policy if exists "ai_conversations: members write" on %I.ai_conversations', p_schema_name);
  execute format('drop policy if exists "ai_conversations: owner update"  on %I.ai_conversations', p_schema_name);
  execute format('drop policy if exists "ai_conversations: owner delete"  on %I.ai_conversations', p_schema_name);

  execute format('create policy "ai_conversations: members read"  on %I.ai_conversations for select using (public.is_tenant_member(tenant_id) and (created_by = auth.uid() or is_shared = true))', p_schema_name);
  execute format('create policy "ai_conversations: members write" on %I.ai_conversations for insert with check (public.can_tenant_write(tenant_id) and created_by = auth.uid())', p_schema_name);
  execute format('create policy "ai_conversations: owner update"  on %I.ai_conversations for update using (created_by = auth.uid() and public.can_tenant_write(tenant_id)) with check (created_by = auth.uid() and public.can_tenant_write(tenant_id))', p_schema_name);
  execute format('create policy "ai_conversations: owner delete"  on %I.ai_conversations for delete using (created_by = auth.uid() and public.is_tenant_member(tenant_id))', p_schema_name);

  execute format('drop trigger if exists ai_conversations_updated_at on %I.ai_conversations', p_schema_name);
  execute format('create trigger ai_conversations_updated_at before update on %I.ai_conversations for each row execute procedure public.set_updated_at()', p_schema_name);


  -- ── 6. ai_messages ───────────────────────────────────────

  execute format(
    'create table if not exists %I.ai_messages ('
    '  id              uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id       uuid        not null default %L::uuid,'
    '  conversation_id uuid        not null,'
    '  role            text        not null check (role in (''user'',''assistant'',''system'')),'
    '  content         text        not null,'
    '  tokens_used     integer,'
    '  created_at      timestamptz not null default now()'
    ')',
    p_schema_name, p_tenant_id
  );
  execute format('alter table %I.ai_messages enable row level security', p_schema_name);

  execute format('drop policy if exists "ai_messages: members read"  on %I.ai_messages', p_schema_name);
  execute format('drop policy if exists "ai_messages: members write" on %I.ai_messages', p_schema_name);

  execute format('create policy "ai_messages: members read"  on %I.ai_messages for select using (public.is_tenant_member(tenant_id))', p_schema_name);
  execute format('create policy "ai_messages: members write" on %I.ai_messages for insert with check (public.can_tenant_write(tenant_id))', p_schema_name);
  -- No UPDATE policy — messages are immutable after creation.


  -- ── 7. document_embeddings ───────────────────────────────

  execute format(
    'create table if not exists %I.document_embeddings ('
    '  id            uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id     uuid        not null default %L::uuid,'
    '  source_type   text        not null check (source_type in (''company'',''property'',''person'',''report'',''search_result'',''custom'')),'
    '  source_id     text        not null,'
    '  chunk_index   integer     not null default 0,'
    '  content       text        not null,'
    '  embedding     extensions.vector(1536) not null,'
    '  metadata      jsonb       not null default ''{}''::jsonb,'
    '  created_at    timestamptz not null default now()'
    ')',
    p_schema_name, p_tenant_id
  );

  execute format(
    'create index if not exists document_embeddings_hnsw_idx on %I.document_embeddings using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64)',
    p_schema_name
  );
  execute format(
    'create index if not exists document_embeddings_source_idx on %I.document_embeddings (tenant_id, source_type, source_id)',
    p_schema_name
  );

  execute format('alter table %I.document_embeddings enable row level security', p_schema_name);

  execute format('drop policy if exists "document_embeddings: members read"  on %I.document_embeddings', p_schema_name);
  execute format('drop policy if exists "document_embeddings: members write" on %I.document_embeddings', p_schema_name);
  execute format('drop policy if exists "document_embeddings: admin delete"  on %I.document_embeddings', p_schema_name);

  execute format('create policy "document_embeddings: members read"  on %I.document_embeddings for select using (public.is_tenant_member(tenant_id))', p_schema_name);
  execute format('create policy "document_embeddings: members write" on %I.document_embeddings for insert with check (public.can_tenant_write(tenant_id))', p_schema_name);
  execute format('create policy "document_embeddings: admin delete"  on %I.document_embeddings for delete using (public.is_tenant_admin(tenant_id))', p_schema_name);


  -- ── 8. audit_log ─────────────────────────────────────────

  execute format(
    'create table if not exists %I.audit_log ('
    '  id            uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id     uuid        not null default %L::uuid,'
    '  user_id       uuid        references auth.users(id) on delete set null,'
    '  action        text        not null,'
    '  resource_type text        not null,'
    '  resource_id   text,'
    '  metadata      jsonb       default ''{}''::jsonb,'
    '  ip_address    inet,'
    '  created_at    timestamptz not null default now()'
    ')',
    p_schema_name, p_tenant_id
  );
  execute format('alter table %I.audit_log enable row level security', p_schema_name);

  execute format('drop policy if exists "audit_log: members read" on %I.audit_log', p_schema_name);
  execute format('create policy "audit_log: members read" on %I.audit_log for select using (public.is_tenant_member(tenant_id))', p_schema_name);
  -- No INSERT policy for authenticated — audit writes go via service_role only.


  -- ── 9. Privileges ────────────────────────────────────────

  execute format('grant select, insert, update, delete on all tables in schema %I to authenticated', p_schema_name);
  execute format('grant all on all tables in schema %I to service_role', p_schema_name);
  execute format('grant usage, select on all sequences in schema %I to authenticated', p_schema_name);
  execute format('grant all on all sequences in schema %I to service_role', p_schema_name);
  execute format('alter default privileges in schema %I grant select, insert, update, delete on tables to authenticated', p_schema_name);
  execute format('alter default privileges in schema %I grant all on tables to service_role', p_schema_name);

end;
$OUTER$;

comment on function public.provision_tenant_schema(text, uuid) is
  'Creates a fully isolated schema for a new BizzAssist tenant. '
  'Idempotent — safe to call multiple times (DROP IF EXISTS before every CREATE POLICY/TRIGGER). '
  'ISO 27001 A.9, A.12, A.14.';


-- ── Lock down execute permissions ────────────────────────────
-- By default PostgreSQL grants EXECUTE to PUBLIC on new functions.
-- provision_tenant_schema must only be called by service_role / postgres.

revoke execute on function public.provision_tenant_schema(text, uuid) from public;
revoke execute on function public.provision_tenant_schema(text, uuid) from anon;
revoke execute on function public.provision_tenant_schema(text, uuid) from authenticated;
grant  execute on function public.provision_tenant_schema(text, uuid) to service_role;
