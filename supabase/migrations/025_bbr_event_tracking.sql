-- ============================================================
-- Migration 025: BBR hændelser — event cursor + tracked object index
-- BizzAssist
--
-- Opretter to tabeller i public schema til BBR event-håndtering:
--
--   bbr_event_cursor
--     Enkelt-rækket tabel der gemmer tidsstemplet for det seneste
--     behandlede BBR hændelse fra Datafordeler. Bruges af pull-cronen.
--
--   bbr_tracked_objects
--     Reverse-index: BBR objekt-UUID → BFE-nummer + tenant.
--     Udfyldes når en ejendom følges og renses når den holdes op
--     med at følges. Gør det muligt at matche Datafordeler BBR-events
--     direkte mod fulgte ejendomme uden yderligere API-kald.
--
-- ISO 27001 A.12.4 (Logging), A.13.1 (Netværkssikkerhed)
-- Retention: bbr_event_cursor opdateres løbende (ingen ophobning).
--            bbr_tracked_objects slettes når monitoring stoppes.
-- ============================================================


-- ── bbr_event_cursor ─────────────────────────────────────────────────────────
-- Enkelt-rækket tabel — opret kun med id=1.
-- Kursorens initialtidspunkt sættes til "nu" ved oprettelse,
-- så første pull-kørsel kun henter fremtidige events.

create table if not exists public.bbr_event_cursor (
  id                   integer     primary key check (id = 1),
  last_event_at        timestamptz not null default now(),
  last_pulled_at       timestamptz,
  total_events_pulled  bigint      not null default 0,
  updated_at           timestamptz not null default now()
);

comment on table public.bbr_event_cursor is
  'Enkelt-rækket cursor for Datafordeler BBR hændelsesbesked pull. '
  'Opdateres af /api/cron/pull-bbr-events efter hver kørsel.';

-- Sæt initialkursor til nu (første kørsel henter kun fremtidige events)
insert into public.bbr_event_cursor (id, last_event_at)
values (1, now())
on conflict (id) do nothing;

-- RLS: kun service_role må skrive; ingen direkte brugeradgang
alter table public.bbr_event_cursor enable row level security;
drop policy if exists "bbr_event_cursor: no direct access" on public.bbr_event_cursor;
create policy "bbr_event_cursor: no direct access"
  on public.bbr_event_cursor for all
  using (false);  -- kun service_role (bypass RLS) må tilgå

grant all on public.bbr_event_cursor to service_role;
revoke all on public.bbr_event_cursor from anon, authenticated;


-- ── bbr_tracked_objects ───────────────────────────────────────────────────────
-- Reverse-index: BBR objekt-UUID → BFE + tenant.
-- Udfyldes af /api/tracked (POST) og renses af /api/tracked (DELETE).

create table if not exists public.bbr_tracked_objects (
  id              uuid        primary key default extensions.uuid_generate_v4(),
  tenant_id       uuid        not null,
  bfe_nummer      text        not null,
  bbr_object_id   uuid        not null,
  bbr_object_type text        not null check (bbr_object_type in ('Bygning', 'Grund', 'Enhed', 'Etage', 'OpgangDørenhed')),
  created_at      timestamptz not null default now(),

  unique (tenant_id, bfe_nummer, bbr_object_id)
);

comment on table public.bbr_tracked_objects is
  'Reverse-index: BBR objekt-UUID til BFE-nummer for fulgte ejendomme. '
  'Gør det muligt at matche Datafordeler BBR-events mod tracked properties '
  'uden at kalde BBR API ved hvert event. Opdateres af /api/tracked.';

create index if not exists bbr_tracked_objects_obj_idx
  on public.bbr_tracked_objects (bbr_object_id);

create index if not exists bbr_tracked_objects_tenant_bfe_idx
  on public.bbr_tracked_objects (tenant_id, bfe_nummer);

-- RLS: kun service_role; brugeradgang via API-routes
alter table public.bbr_tracked_objects enable row level security;
drop policy if exists "bbr_tracked_objects: no direct access" on public.bbr_tracked_objects;
create policy "bbr_tracked_objects: no direct access"
  on public.bbr_tracked_objects for all
  using (false);

grant all on public.bbr_tracked_objects to service_role;
revoke all on public.bbr_tracked_objects from anon, authenticated;
grant usage, select on all sequences in schema public to service_role;
