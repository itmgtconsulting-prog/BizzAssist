-- Migration 219: public.system_audit_log — system-hændelser uden enkelt tenant (BIZZ-2293/2297)
--
-- Rod-årsag (bug): Den delte helper app/lib/auditLog.ts kaldte
-- `admin.from('audit_log').insert(...)` mod public-skemaet. Der findes INGEN
-- `public.audit_log`-tabel (audit-rækker bor i hvert tenants eget skema:
-- `tenant_<x>.audit_log`). PostgREST-insert'et fejlede derfor altid lydløst
-- (fejlen blev ignoreret), så INGEN af de 41 kaldesteder skrev faktisk en
-- audit-række — et ISO 27001 A.12.4-brud (manglende hændelses-logging).
--
-- Fix (to dele):
--   1) Tenant-hændelser (langt de fleste) rutes nu til det korrekte
--      `tenant_<x>.audit_log` via helperen (self-resolve af tenant-skema).
--   2) System-hændelser UDEN en enkelt tenant (Stripe-webhooks, super-admin
--      service-manager, bootstrap, anonym consent, support-ticket-oprettelse)
--      har intet tenant-skema at skrive til. Denne migration opretter en
--      dedikeret `public.system_audit_log` til dem.
--
-- Isolation: tabellen er system-global og indeholder PER DESIGN ingen
-- tenant-scoped persondata — kun infrastruktur-hændelser. RLS er slået til og
-- nægter al adgang for almindelige roller; kun service_role (admin-klienten,
-- som bypasser RLS) skriver/læser her. Ingen cross-tenant-data blandes, fordi
-- tenant-hændelser aldrig lander her.
--
-- Retention: 24 måneder (ryddes af /api/cron/purge-old-data sammen med øvrige
-- audit-data; system-hændelser er ikke persondata og har en længere, men
-- stadig afgrænset, opbevaringsperiode).

create table if not exists public.system_audit_log (
  id            uuid        primary key default gen_random_uuid(),
  action        text        not null,
  resource_type text        not null,
  resource_id   text,
  metadata      jsonb,
  created_at    timestamptz not null default now()
);

comment on table public.system_audit_log is
  'System-globale audit-hændelser uden enkelt tenant (webhooks, super-admin, bootstrap). Ingen tenant-scoped PII. BIZZ-2293/2297.';

-- Opslags-indeks til audit-gennemgang (seneste hændelser, filtrér på action).
create index if not exists system_audit_log_created_at_idx
  on public.system_audit_log (created_at desc);
create index if not exists system_audit_log_action_idx
  on public.system_audit_log (action);

-- RLS: nægt alt for alle almindelige roller. service_role (admin-klienten)
-- bypasser RLS og er den eneste vej ind/ud — ingen policies oprettes bevidst.
alter table public.system_audit_log enable row level security;

-- Tilbagekald bredt adgang; service_role bevarer sin indbyggede bypass.
revoke all on public.system_audit_log from anon, authenticated;
