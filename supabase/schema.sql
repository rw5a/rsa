-- =====================================================================
-- Availability Scheduler — Supabase schema (fresh project)
-- Run this whole file once in Supabase Dashboard > SQL Editor.
--
-- Contents
--   Step 2  Tables + constraints
--   Step 3  Row-level security (RLS)
--   Step 4  Triggers (deadline enforcement, immutability guards) + RPC
--   Step 5  Realtime publication + retention (pg_cron purge)
--
-- Prerequisite (Step 1, dashboard): Authentication > Sign In / Providers >
-- enable "Allow anonymous sign-ins".
-- =====================================================================


-- ---------------------------------------------------------------------
-- STEP 2 — TABLES
-- ---------------------------------------------------------------------

create table if not exists public.events (
  code         text primary key
               check (code ~ '^[A-Z0-9]{6}$'),
  name         text not null
               check (char_length(btrim(name)) between 1 and 120),
  owner_id     uuid not null default auth.uid()
               references auth.users (id) on delete cascade,

  -- Canonical IANA time zone. Every slot is a wall-clock time in this zone.
  tz           text not null,

  -- 'range'  = contiguous start_date..end_date (inclusive)
  -- 'custom' = hand-picked dates stored in `dates`; start/end hold min/max
  date_mode    text not null default 'range'
               check (date_mode in ('range', 'custom')),
  start_date   date not null,
  end_date     date not null,
  dates        jsonb not null default '[]'::jsonb,

  -- Daily window, in whole hours of the event zone. Whole-day = 0..24.
  start_hour   int not null default 9  check (start_hour between 0 and 23),
  end_hour     int not null default 17 check (end_hour between 1 and 24),

  -- Slot size in minutes. Any value 1..1440 (client snaps to 5..1440).
  granularity  int not null default 30 check (granularity between 1 and 1440),

  -- Optional response deadline (UTC instant).
  deadline     timestamptz,

  -- When true, non-organizers only ever receive counts, never names.
  anonymous    boolean not null default false,

  -- Organizer-confirmed slot keys: ["YYYY-MM-DD|HH:MM", ...]
  finalized    jsonb not null default '[]'::jsonb,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint events_dates_order   check (end_date >= start_date),
  -- 62-day cap on contiguous ranges (custom mode is capped by count instead)
  constraint events_range_cap     check (date_mode = 'custom' or end_date - start_date <= 61),
  constraint events_hours_order   check (end_hour > start_hour),
  -- `dates` must be a JSON array with at most 31 entries
  constraint events_dates_array   check (jsonb_typeof(dates) = 'array' and jsonb_array_length(dates) <= 31),
  constraint events_custom_dates  check (date_mode = 'range' or jsonb_array_length(dates) >= 1),
  constraint events_finalized_arr check (jsonb_typeof(finalized) = 'array')
);

create table if not exists public.submissions (
  id          uuid primary key default gen_random_uuid(),
  event_code  text not null references public.events (code) on delete cascade,
  user_id     uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  -- Selected slot keys: ["YYYY-MM-DD|HH:MM", ...]
  slots       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint submissions_one_per_user unique (event_code, user_id),
  constraint submissions_slots_array  check (jsonb_typeof(slots) = 'array' and jsonb_array_length(slots) <= 20000)
);

create index if not exists submissions_event_idx on public.submissions (event_code);
create index if not exists events_end_date_idx   on public.events (end_date);


-- ---------------------------------------------------------------------
-- STEP 3 — ROW-LEVEL SECURITY
-- Everyone signs in (anonymously), so all real traffic uses the
-- `authenticated` role. The bare `anon` role gets nothing.
-- ---------------------------------------------------------------------

alter table public.events      enable row level security;
alter table public.submissions enable row level security;

revoke all on public.events, public.submissions from anon;
grant select, insert, update, delete on public.events, public.submissions to authenticated;

-- Helpers (security definer so policies can consult events without recursion)
create or replace function public.is_event_owner(p_code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.events
    where code = p_code and owner_id = auth.uid()
  );
$$;

create or replace function public.event_is_anonymous(p_code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select anonymous from public.events where code = p_code), true);
$$;

revoke all on function public.is_event_owner(text)     from public, anon;
revoke all on function public.event_is_anonymous(text) from public, anon;
grant execute on function public.is_event_owner(text)     to authenticated;
grant execute on function public.event_is_anonymous(text) to authenticated;

-- EVENTS ---------------------------------------------------------------
drop policy if exists events_select on public.events;
drop policy if exists events_insert on public.events;
drop policy if exists events_update on public.events;
drop policy if exists events_delete on public.events;

-- Event config is readable by any signed-in user who knows the code.
create policy events_select on public.events
  for select to authenticated using (true);

-- You can only create events you own.
create policy events_insert on public.events
  for insert to authenticated with check (owner_id = auth.uid());

-- Only the organizer can edit or finalize.
create policy events_update on public.events
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy events_delete on public.events
  for delete to authenticated using (owner_id = auth.uid());

-- SUBMISSIONS ----------------------------------------------------------
drop policy if exists subs_select on public.submissions;
drop policy if exists subs_insert on public.submissions;
drop policy if exists subs_update on public.submissions;
drop policy if exists subs_delete on public.submissions;

-- A row is readable only if it is yours, you organize the event, or the
-- event is NOT anonymous. Do NOT replace this with `using (true)` — that
-- single change silently re-opens the name leak on anonymous events.
create policy subs_select on public.submissions
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_event_owner(event_code)
    or not public.event_is_anonymous(event_code)
  );

-- You can only write your own row.
create policy subs_insert on public.submissions
  for insert to authenticated with check (user_id = auth.uid());

create policy subs_update on public.submissions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Delete succeeds only if the row is yours OR you own the parent event.
create policy subs_delete on public.submissions
  for delete to authenticated
  using (user_id = auth.uid() or public.is_event_owner(event_code));


-- ---------------------------------------------------------------------
-- STEP 4 — TRIGGERS + RPC
-- ---------------------------------------------------------------------

-- Events: code/owner are immutable; maintain updated_at.
create or replace function public.events_guard()
returns trigger
language plpgsql
as $$
begin
  if new.code <> old.code or new.owner_id <> old.owner_id then
    raise exception 'Event code and organizer cannot be changed';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists events_guard on public.events;
create trigger events_guard
  before update on public.events
  for each row execute function public.events_guard();

-- Submissions: server-side deadline (organizer exempt) + immutability.
create or replace function public.submissions_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  e public.events;
begin
  if tg_op = 'UPDATE' and (new.event_code <> old.event_code or new.user_id <> old.user_id) then
    raise exception 'Submission event and owner cannot be changed';
  end if;

  select * into e from public.events where code = new.event_code;

  if e.deadline is not null
     and now() > e.deadline
     and e.owner_id is distinct from auth.uid() then
    raise exception 'Responses are closed' using errcode = 'P0001';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists submissions_guard on public.submissions;
create trigger submissions_guard
  before insert or update on public.submissions
  for each row execute function public.submissions_guard();

-- Read path for the heatmap. Returns every row's slots, but NULLs the name
-- when the caller is a non-organizer on an anonymous event. RLS cannot hide
-- a single column, so names are stripped here, server-side.
create or replace function public.get_event_submissions(p_code text)
returns table (id uuid, name text, slots jsonb, is_mine boolean, updated_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select
    s.id,
    case
      when e.anonymous and e.owner_id is distinct from auth.uid() then null
      else s.name
    end as name,
    s.slots,
    (s.user_id = auth.uid()) as is_mine,
    s.updated_at
  from public.submissions s
  join public.events e on e.code = s.event_code
  where s.event_code = p_code
    and auth.uid() is not null
  order by s.created_at;
$$;

revoke all on function public.get_event_submissions(text) from public, anon;
grant execute on function public.get_event_submissions(text) to authenticated;


-- ---------------------------------------------------------------------
-- STEP 5 — REALTIME + RETENTION
-- ---------------------------------------------------------------------

-- Realtime respects RLS SELECT, so on anonymous events non-organizers only
-- receive their own row; the client falls back to polling the RPC there.
do $$
begin
  begin
    alter publication supabase_realtime add table public.events;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.submissions;
  exception when duplicate_object then null;
  end;
end $$;

-- Retention: delete events 15 days after their end date.
-- FK `on delete cascade` removes their submissions too.
create or replace function public.purge_expired_events()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  n integer;
begin
  delete from public.events
  where end_date < (current_date - 15);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.purge_expired_events() from public, anon, authenticated;

-- Daily at 03:15 UTC. (Enable pg_cron under Database > Extensions if this errors.)
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('purge-expired-events')
  where exists (select 1 from cron.job where jobname = 'purge-expired-events');
end $$;

select cron.schedule(
  'purge-expired-events',
  '15 3 * * *',
  $$select public.purge_expired_events();$$
);

-- Manual run (UAT TC-38):  select public.purge_expired_events();
