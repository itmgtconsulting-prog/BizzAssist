-- ============================================================
-- Migration 004: Tenant template schema
-- BizzAssist — BIZZ-9
-- ============================================================
-- Creates the SQL function public.provision_tenant_schema() which,
-- when called for a new tenant, creates a fully isolated PostgreSQL
-- schema containing all per-company tables with RLS.
--
-- Pattern: schema-per-tenant
--   • public schema  → shared data (users, tenants, plans, …)
--   • tenant_[uuid]  → per-company isolated data
--
-- Each tenant schema contains:
--   saved_entities      — watched companies / properties / people
--   saved_searches      — saved search queries
--   reports             — generated analysis reports
--   ai_conversations    — AI chat threads
--   ai_messages         — individual messages in a thread
--   document_embeddings — pgvector embeddings for RAG / semantic search
--   audit_log           — immutable record of all mutations (ISO 27001 A.12)
--
-- NOTE: updated_at triggers reuse public.set_updated_at() from migration 002.
-- No per-schema trigger functions are created to avoid nested dollar-quoting.
--
-- ISO 27001:
--   A.9  — Access Control  (RLS policies)
--   A.12 — Operations      (audit_log immutability)
--   A.14 — Secure Dev      (SECURITY DEFINER, explicit search_path)
-- ============================================================


-- ── Helper: check if current user is a tenant member ─────────
-- Complements is_tenant_admin() from migration 003.
-- SECURITY DEFINER breaks the RLS self-reference loop.

create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_memberships
    where tenant_id = p_tenant_id
      and user_id   = auth.uid()
  );
$$;

comment on function public.is_tenant_member(uuid) is
  'Returns true if the authenticated user has any role in the given tenant. '
  'SECURITY DEFINER to avoid RLS recursion. ISO 27001 A.9.';


-- ── Helper: check if current user can write (member or admin) ─

create or replace function public.can_tenant_write(p_tenant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_memberships
    where tenant_id = p_tenant_id
      and user_id   = auth.uid()
      and role in ('tenant_member', 'tenant_admin')
  );
$$;

comment on function public.can_tenant_write(uuid) is
  'Returns true if the authenticated user can write data for this tenant '
  '(role = tenant_member or tenant_admin). ISO 27001 A.9.';


-- ============================================================
-- Provisioning function
-- ============================================================
-- Called once per new tenant after inserting into public.tenants.
-- Usage:
--   SELECT public.provision_tenant_schema('tenant_abc123', 'uuid-of-tenant');
--
-- Idempotent: all CREATE statements use IF NOT EXISTS.
-- ============================================================

create or replace function public.provision_tenant_schema(
  p_schema_name text,   -- e.g. 'tenant_abc123'
  p_tenant_id   uuid    -- the matching public.tenants.id
)
returns void
language plpgsql
security definer
set search_path = public
as $OUTER$
begin

  -- ── 1. Create the schema ──────────────────────────────────

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

  execute format(
    'alter table %I.saved_entities enable row level security',
    p_schema_name
  );
  execute format(
    'create policy "saved_entities: members read" on %I.saved_entities'
    '  for select using (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "saved_entities: members write" on %I.saved_entities'
    '  for insert with check (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "saved_entities: members update" on %I.saved_entities'
    '  for update using (public.can_tenant_write(tenant_id))'
    '  with check (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "saved_entities: admin delete" on %I.saved_entities'
    '  for delete using (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );
  execute format(
    'create trigger saved_entities_updated_at'
    '  before update on %I.saved_entities'
    '  for each row execute procedure public.set_updated_at()',
    p_schema_name
  );


  -- ── 3. saved_searches ────────────────────────────────────

  execute format(
    'create table if not exists %I.saved_searches ('
    '  id           uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        not null default %L::uuid,'
    '  query        text        not null,'
    '  filters      jsonb       not null default ''{}''::jsonb,'
    '  entity_type  text        not null default ''all'''
    '               check (entity_type in (''company'',''property'',''person'',''all'')),'
    '  result_count integer,'
    '  created_by   uuid        not null references auth.users(id) on delete set null,'
    '  created_at   timestamptz not null default now()'
    ')',
    p_schema_name, p_tenant_id
  );

  execute format(
    'alter table %I.saved_searches enable row level security',
    p_schema_name
  );
  execute format(
    'create policy "saved_searches: members read" on %I.saved_searches'
    '  for select using (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "saved_searches: members write" on %I.saved_searches'
    '  for insert with check (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "saved_searches: admin delete" on %I.saved_searches'
    '  for delete using (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );


  -- ── 4. reports ───────────────────────────────────────────

  execute format(
    'create table if not exists %I.reports ('
    '  id           uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        not null default %L::uuid,'
    '  title        text        not null,'
    '  report_type  text        not null'
    '               check (report_type in (''company_analysis'',''property_report'','
    '                                      ''person_report'',''market_overview'',''custom'')),'
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

  execute format(
    'alter table %I.reports enable row level security',
    p_schema_name
  );
  execute format(
    'create policy "reports: members read" on %I.reports'
    '  for select using (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "reports: members write" on %I.reports'
    '  for insert with check (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "reports: members update" on %I.reports'
    '  for update using (public.can_tenant_write(tenant_id))'
    '  with check (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "reports: admin delete" on %I.reports'
    '  for delete using (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );
  execute format(
    'create trigger reports_updated_at'
    '  before update on %I.reports'
    '  for each row execute procedure public.set_updated_at()',
    p_schema_name
  );


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

  execute format(
    'alter table %I.ai_conversations enable row level security',
    p_schema_name
  );
  execute format(
    'create policy "ai_conversations: members read" on %I.ai_conversations'
    '  for select using ('
    '    public.is_tenant_member(tenant_id)'
    '    and (created_by = auth.uid() or is_shared = true)'
    '  )',
    p_schema_name
  );
  execute format(
    'create policy "ai_conversations: members write" on %I.ai_conversations'
    '  for insert with check ('
    '    public.can_tenant_write(tenant_id) and created_by = auth.uid()'
    '  )',
    p_schema_name
  );
  execute format(
    'create policy "ai_conversations: owner update" on %I.ai_conversations'
    '  for update'
    '  using  (created_by = auth.uid() and public.can_tenant_write(tenant_id))'
    '  with check (created_by = auth.uid() and public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "ai_conversations: owner delete" on %I.ai_conversations'
    '  for delete using (created_by = auth.uid() and public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  execute format(
    'create trigger ai_conversations_updated_at'
    '  before update on %I.ai_conversations'
    '  for each row execute procedure public.set_updated_at()',
    p_schema_name
  );


  -- ── 6. ai_messages ───────────────────────────────────────
  -- Immutable after insert — no update_at trigger needed.

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

  execute format(
    'alter table %I.ai_messages enable row level security',
    p_schema_name
  );
  execute format(
    'create policy "ai_messages: members read" on %I.ai_messages'
    '  for select using (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "ai_messages: members write" on %I.ai_messages'
    '  for insert with check (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  -- No UPDATE policy — messages are immutable after creation.


  -- ── 7. document_embeddings ───────────────────────────────
  -- pgvector(1536) with HNSW index for semantic search / RAG.

  execute format(
    'create table if not exists %I.document_embeddings ('
    '  id            uuid        primary key default extensions.uuid_generate_v4(),'
    '  tenant_id     uuid        not null default %L::uuid,'
    '  source_type   text        not null'
    '                check (source_type in (''company'',''property'',''person'','
    '                                       ''report'',''search_result'',''custom'')),'
    '  source_id     text        not null,'
    '  chunk_index   integer     not null default 0,'
    '  content       text        not null,'
    '  embedding     extensions.vector(1536) not null,'
    '  metadata      jsonb       not null default ''{}''::jsonb,'
    '  created_at    timestamptz not null default now()'
    ')',
    p_schema_name, p_tenant_id
  );

  -- HNSW index for approximate nearest-neighbour search (cosine distance)
  execute format(
    'create index if not exists document_embeddings_hnsw_idx'
    '  on %I.document_embeddings'
    '  using hnsw (embedding extensions.vector_cosine_ops)'
    '  with (m = 16, ef_construction = 64)',
    p_schema_name
  );

  -- Composite index for filtered similarity searches
  execute format(
    'create index if not exists document_embeddings_source_idx'
    '  on %I.document_embeddings (tenant_id, source_type, source_id)',
    p_schema_name
  );

  execute format(
    'alter table %I.document_embeddings enable row level security',
    p_schema_name
  );
  execute format(
    'create policy "document_embeddings: members read" on %I.document_embeddings'
    '  for select using (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "document_embeddings: members write" on %I.document_embeddings'
    '  for insert with check (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  execute format(
    'create policy "document_embeddings: admin delete" on %I.document_embeddings'
    '  for delete using (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );


  -- ── 8. audit_log ─────────────────────────────────────────
  -- Immutable. No UPDATE or DELETE RLS policy — app code cannot
  -- modify rows. Service role can delete for GDPR erasure only.

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

  execute format(
    'alter table %I.audit_log enable row level security',
    p_schema_name
  );
  execute format(
    'create policy "audit_log: members read" on %I.audit_log'
    '  for select using (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  -- INSERT only via service_role (admin client) — no authenticated insert policy.


  -- ── 9. Grant privileges ───────────────────────────────────

  execute format(
    'grant select, insert, update, delete on all tables in schema %I to authenticated',
    p_schema_name
  );
  execute format(
    'grant all on all tables in schema %I to service_role',
    p_schema_name
  );
  execute format(
    'grant usage, select on all sequences in schema %I to authenticated',
    p_schema_name
  );
  execute format(
    'grant all on all sequences in schema %I to service_role',
    p_schema_name
  );
  execute format(
    'alter default privileges in schema %I'
    '  grant select, insert, update, delete on tables to authenticated',
    p_schema_name
  );
  execute format(
    'alter default privileges in schema %I'
    '  grant all on tables to service_role',
    p_schema_name
  );

end;
$OUTER$;

comment on function public.provision_tenant_schema(text, uuid) is
  'Creates a fully isolated schema for a new BizzAssist tenant. '
  'Idempotent — safe to call multiple times. '
  'Call once after inserting a row into public.tenants. '
  'updated_at triggers use public.set_updated_at() from migration 002. '
  'ISO 27001 A.9, A.12, A.14.';
