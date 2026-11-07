-- =====================================================================
-- GatePass // Event Ops  —  Supabase (PostgreSQL) migration
-- Run this whole script once in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run (idempotent).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  event_date  date not null,
  capacity    int  not null check (capacity > 0)
);

create table if not exists public.attendees (
  id           serial primary key,
  event_id     uuid not null references public.events(id) on delete cascade,
  full_name    text not null check (length(btrim(full_name)) > 0),
  email        text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  student_id   text not null check (length(btrim(student_id)) > 0),
  pass_code    text not null unique check (pass_code ~ '^PASS-[A-Z0-9]{4}$'),
  is_admitted  boolean not null default false,
  admitted_at  timestamptz,
  created_at   timestamptz not null default now(),

  -- One registration per student per event
  constraint attendees_event_student_unique unique (event_id, student_id)
);

-- One registration per email per event (case-insensitive)
create unique index if not exists attendees_event_email_unique
  on public.attendees (event_id, lower(email));

create index if not exists attendees_event_created_idx
  on public.attendees (event_id, created_at desc);

-- ---------------------------------------------------------------------
-- 2. Triggers
-- ---------------------------------------------------------------------

-- Stamp admitted_at server-side the moment is_admitted flips to true.
create or replace function public.set_admitted_at()
returns trigger
language plpgsql
as $$
begin
  if new.is_admitted and not coalesce(old.is_admitted, false) then
    new.admitted_at := now();
  elsif not new.is_admitted then
    new.admitted_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_admitted_at on public.attendees;
create trigger trg_set_admitted_at
  before update of is_admitted on public.attendees
  for each row execute function public.set_admitted_at();

-- Reject registrations once the event is at capacity.
create or replace function public.enforce_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap int;
  taken int;
begin
  select capacity into cap from public.events where id = new.event_id for share;
  select count(*) into taken from public.attendees where event_id = new.event_id;
  if taken >= cap then
    raise exception 'EVENT_FULL: this event has reached its capacity of %', cap
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_capacity on public.attendees;
create trigger trg_enforce_capacity
  before insert on public.attendees
  for each row execute function public.enforce_capacity();

-- ---------------------------------------------------------------------
-- 3. Row Level Security — permissive public access for the anon key
--    (demo / hackathon setup. See README for hardening notes.)
-- ---------------------------------------------------------------------
alter table public.events    enable row level security;
alter table public.attendees enable row level security;

drop policy if exists "events_public_select"    on public.events;
drop policy if exists "attendees_public_select" on public.attendees;
drop policy if exists "attendees_public_insert" on public.attendees;
drop policy if exists "attendees_public_update" on public.attendees;

create policy "events_public_select"
  on public.events for select to anon, authenticated using (true);

create policy "attendees_public_select"
  on public.attendees for select to anon, authenticated using (true);

create policy "attendees_public_insert"
  on public.attendees for insert to anon, authenticated with check (true);

create policy "attendees_public_update"
  on public.attendees for update to anon, authenticated using (true) with check (true);

-- Table privileges (Supabase usually grants these already; explicit is safer)
grant usage on schema public to anon, authenticated;
grant select                 on public.events    to anon, authenticated;
grant select, insert, update on public.attendees to anon, authenticated;
grant usage, select on sequence public.attendees_id_seq to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Seed one event (edit title / date / capacity as needed)
-- ---------------------------------------------------------------------
insert into public.events (title, event_date, capacity)
select 'TechFest 2026 — Opening Night', current_date + 14, 500
where not exists (select 1 from public.events);
