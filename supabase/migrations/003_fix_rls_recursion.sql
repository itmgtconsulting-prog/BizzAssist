-- ============================================================
-- Migration 003: Fix RLS infinite recursion
-- BizzAssist — BIZZ-8 patch
-- ============================================================
-- The memberships: admin manage policy on tenant_memberships
-- queries tenant_memberships from within its own policy, causing
-- PostgreSQL error 42P17 (infinite recursion).
--
-- Fix: extract the admin-check into a SECURITY DEFINER function.
-- SECURITY DEFINER bypasses RLS when the function executes,
-- breaking the recursive loop. ISO 27001 A.9 (Access Control).
-- ============================================================


-- ── Helper: check if current user is a tenant admin ──────────
-- SECURITY DEFINER runs as the function owner (postgres), which
-- bypasses RLS — this is intentional and safe here because the
-- function only returns a boolean and exposes no data.

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
  'Uses SECURITY DEFINER to avoid RLS recursion. ISO 27001 A.9.';


-- ── Drop and recreate the recursive policies ─────────────────

-- memberships: admin manage  (was recursive — queried self)
drop policy if exists "memberships: admin manage" on public.tenant_memberships;
create policy "memberships: admin manage"
  on public.tenant_memberships for all
  using (public.is_tenant_admin(tenant_id));


-- tenants: read own  (depended on tenant_memberships which was broken)
-- Re-create using the same helper for consistency.
drop policy if exists "tenants: read own" on public.tenants;
create policy "tenants: read own"
  on public.tenants for select
  using (public.is_tenant_admin(id) or exists (
    select 1 from public.tenant_memberships
    where tenant_id = tenants.id
      and user_id   = auth.uid()
  ));


-- subscriptions: read own  (same dependency chain)
drop policy if exists "subscriptions: read own" on public.subscriptions;
create policy "subscriptions: read own"
  on public.subscriptions for select
  using (exists (
    select 1 from public.tenant_memberships
    where tenant_id = subscriptions.tenant_id
      and user_id   = auth.uid()
  ));
