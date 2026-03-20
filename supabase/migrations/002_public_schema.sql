-- ============================================================
-- Migration 002: Public shared schema
-- BizzAssist — BIZZ-8
-- ============================================================
-- Tables in the public schema are shared across all tenants.
-- All tables have RLS enabled — no data is accessible without
-- an explicit policy. Implements ISO 27001 A.9 (Access Control).
-- ============================================================


-- ── Users ────────────────────────────────────────────────────
-- Extends Supabase auth.users with BizzAssist profile fields.
-- Automatically created on first sign-in via trigger below.

create table if not exists public.users (
  id                 uuid        primary key references auth.users(id) on delete cascade,
  email              text        not null unique,
  full_name          text,
  avatar_url         text,
  preferred_language text        not null default 'da' check (preferred_language in ('da', 'en')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.users is
  'BizzAssist user profiles, linked 1:1 to Supabase auth.users.';

alter table public.users enable row level security;

-- Users can read and update their own profile only
create policy "users: read own"
  on public.users for select
  using (auth.uid() = id);

create policy "users: update own"
  on public.users for update
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- ── Tenants ──────────────────────────────────────────────────
-- One row per company/organisation that subscribes to BizzAssist.
-- Each tenant gets their own isolated schema (tenant_[id]).

create table if not exists public.tenants (
  id          uuid        primary key default extensions.uuid_generate_v4(),
  name        text        not null,
  cvr_number  text,
  logo_url    text,
  schema_name text        not null unique,  -- e.g. 'tenant_abc123'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.tenants is
  'One row per BizzAssist customer organisation. Each tenant has an isolated DB schema.';

alter table public.tenants enable row level security;


-- ── Plans ────────────────────────────────────────────────────
-- Subscription plan definitions (managed by BizzAssist admins).

create table if not exists public.plans (
  id                      uuid    primary key default extensions.uuid_generate_v4(),
  name                    text    not null unique check (name in ('free','starter','pro','enterprise')),
  price_dkk_monthly       integer not null default 0,
  max_users               integer not null default 1,
  max_searches_per_day    integer not null default 10,
  ai_enabled              boolean not null default false,
  export_enabled          boolean not null default false
);

comment on table public.plans is
  'BizzAssist subscription plan definitions. Managed by super admins only.';

alter table public.plans enable row level security;

-- Everyone can read plan details (needed for pricing page)
create policy "plans: read all"
  on public.plans for select
  using (true);

-- Seed the four plans
insert into public.plans (name, price_dkk_monthly, max_users, max_searches_per_day, ai_enabled, export_enabled)
values
  ('free',       0,   1,    10,    false, false),
  ('starter',    299, 1,    500,   true,  false),
  ('pro',        799, 5,    99999, true,  true),
  ('enterprise', 0,   9999, 99999, true,  true)
on conflict (name) do nothing;


-- ── Subscriptions ────────────────────────────────────────────
-- Active subscription linking a tenant to a plan.

create table if not exists public.subscriptions (
  id                       uuid        primary key default extensions.uuid_generate_v4(),
  tenant_id                uuid        not null references public.tenants(id) on delete cascade,
  plan_id                  uuid        not null references public.plans(id),
  status                   text        not null default 'trialing'
                             check (status in ('active','cancelled','past_due','trialing')),
  current_period_start     timestamptz not null default now(),
  current_period_end       timestamptz not null default now() + interval '30 days',
  stripe_subscription_id   text,
  created_at               timestamptz not null default now()
);

comment on table public.subscriptions is
  'One active subscription per tenant, linking tenant to their current plan.';

alter table public.subscriptions enable row level security;


-- ── Tenant Memberships ───────────────────────────────────────
-- Joins users to tenants with a role. One user can belong to
-- multiple tenants (e.g. a consultant working for several clients).

create table if not exists public.tenant_memberships (
  id         uuid        primary key default extensions.uuid_generate_v4(),
  tenant_id  uuid        not null references public.tenants(id) on delete cascade,
  user_id    uuid        not null references public.users(id) on delete cascade,
  role       text        not null default 'tenant_member'
               check (role in ('tenant_admin','tenant_member','tenant_viewer')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

comment on table public.tenant_memberships is
  'Links users to tenants with a role. Governs what data a user can access within a tenant.';

alter table public.tenant_memberships enable row level security;

-- Users can see memberships for tenants they belong to
create policy "memberships: read own tenants"
  on public.tenant_memberships for select
  using (auth.uid() = user_id);

-- ── Helper: admin-check without RLS recursion ────────────────
-- SECURITY DEFINER runs as function owner (postgres), bypassing
-- RLS on the lookup. Safe: returns only a boolean, exposes no data.
create or replace function public.is_tenant_admin(p_tenant_id uuid)
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
      and role      = 'tenant_admin'
  );
$$;

comment on function public.is_tenant_admin(uuid) is
  'Returns true if the authenticated user is a tenant_admin for the given tenant. '
  'Uses SECURITY DEFINER to avoid RLS recursion on tenant_memberships. ISO 27001 A.9.';

-- Tenant admins can manage memberships in their tenant
-- Uses is_tenant_admin() to avoid querying tenant_memberships from within
-- its own RLS policy (which causes infinite recursion — PostgreSQL 42P17).
create policy "memberships: admin manage"
  on public.tenant_memberships for all
  using (public.is_tenant_admin(tenant_id));

-- Tenants: members can read their own tenant's record
create policy "tenants: read own"
  on public.tenants for select
  using (
    public.is_tenant_admin(id) or exists (
      select 1 from public.tenant_memberships
      where tenant_id = tenants.id
        and user_id   = auth.uid()
    )
  );

-- Subscriptions: members can read their tenant's subscription
create policy "subscriptions: read own"
  on public.subscriptions for select
  using (
    exists (
      select 1 from public.tenant_memberships
      where tenant_id = subscriptions.tenant_id
        and user_id   = auth.uid()
    )
  );


-- ── Auto-create user profile on signup ───────────────────────
-- When a new user signs up via Supabase Auth, automatically
-- create their public.users profile row.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ── updated_at triggers ──────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_updated_at
  before update on public.users
  for each row execute procedure public.set_updated_at();

create trigger tenants_updated_at
  before update on public.tenants
  for each row execute procedure public.set_updated_at();
