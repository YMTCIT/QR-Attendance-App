-- =============================================================================
-- CIT QR Attendance System — 001 Initial schema
--
-- Check-in ONLY. There are intentionally no time-out / check-out / departure /
-- duration columns anywhere in this schema.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Staff roles (exactly two: admin, scanner). Attendees never get accounts.
-- Rows are written only by privileged backend code (Edge Function with the
-- service role, or SQL run by the project owner). See 002 for RLS.
-- -----------------------------------------------------------------------------
create table public.app_user_roles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        text not null check (role in ('admin', 'scanner')),
  -- Set when an administrator disables a scanner account. A disabled account
  -- has no effective role even if it still holds a valid access token.
  disabled_at timestamptz,
  created_at  timestamptz not null default now()
);

comment on table public.app_user_roles is 'Staff accounts and their single application role (admin | scanner).';

-- -----------------------------------------------------------------------------
-- Events
-- -----------------------------------------------------------------------------
create table public.events (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(btrim(name)) between 1 and 200),
  date       date not null,
  venue      text check (venue is null or char_length(venue) <= 200),
  active     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most ONE active event. A unique index on a constant expression, limited
-- to active rows, allows any number of inactive events but only one active.
create unique index events_single_active_idx on public.events ((true)) where active;
create index events_date_idx on public.events (date desc);

-- -----------------------------------------------------------------------------
-- Attendees (registrations). QR content is created OUTSIDE this application.
-- -----------------------------------------------------------------------------
create table public.attendees (
  id         bigint generated always as identity primary key,
  -- Exact text payload of the externally generated QR code. Not assumed to be
  -- a UUID. Stored trimmed (see normalise trigger) and compared exactly.
  qr_code    text not null unique
             check (char_length(qr_code) between 1 and 512 and qr_code = btrim(qr_code)),
  name       text not null check (char_length(btrim(name)) between 1 and 200),
  -- Text, never numeric, so leading zeros survive.
  id_number  text check (id_number is null or char_length(id_number) <= 64),
  email      text check (email is null or char_length(email) <= 254),
  department text check (department is null or char_length(department) <= 200),
  -- NULL = eligible for any event; non-NULL = only that event.
  -- RESTRICT: an event cannot be deleted while registrations point at it,
  -- otherwise those attendees would silently become "eligible for any event".
  event_id   bigint references public.events (id) on delete restrict,
  source     text not null check (source in ('power_automate', 'import', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index attendees_event_id_idx on public.attendees (event_id);
create index attendees_lower_name_idx on public.attendees (lower(name));

-- -----------------------------------------------------------------------------
-- Attendance (check-in only)
-- -----------------------------------------------------------------------------
create table public.attendance (
  id              bigint generated always as identity primary key,
  event_id        bigint not null references public.events (id) on delete cascade,
  attendee_id     bigint not null references public.attendees (id) on delete cascade,
  scanned_at      timestamptz not null default now(),
  check_in_method text not null check (check_in_method in ('qr', 'manual')),
  recorded_by     uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  -- CRITICAL: one check-in per attendee per event, enforced by the database,
  -- so concurrent scans from several tablets can never create duplicates.
  constraint attendance_event_attendee_unique unique (event_id, attendee_id)
);

create index attendance_attendee_id_idx on public.attendance (attendee_id);
create index attendance_event_scanned_idx on public.attendance (event_id, scanned_at desc);

-- -----------------------------------------------------------------------------
-- Registration import logs (registration only — imports never touch attendance)
-- -----------------------------------------------------------------------------
create table public.import_logs (
  id              bigint generated always as identity primary key,
  imported_by     uuid default auth.uid() references auth.users (id) on delete set null,
  event_id        bigint references public.events (id) on delete set null,
  filename        text not null check (char_length(filename) <= 255),
  total_rows      integer not null default 0 check (total_rows >= 0),
  successful_rows integer not null default 0 check (successful_rows >= 0),
  skipped_rows    integer not null default 0 check (skipped_rows >= 0),
  error_rows      integer not null default 0 check (error_rows >= 0),
  created_at      timestamptz not null default now()
);

create index import_logs_created_idx on public.import_logs (created_at desc);

-- -----------------------------------------------------------------------------
-- Small audit trail for explicit manual attendance corrections
-- -----------------------------------------------------------------------------
create table public.attendance_corrections (
  id                  bigint generated always as identity primary key,
  action              text not null check (action in ('manual_check_in', 'undo_check_in')),
  event_id            bigint references public.events (id) on delete set null,
  attendee_id         bigint references public.attendees (id) on delete set null,
  attendee_name       text,
  original_scanned_at timestamptz,
  reason              text check (reason is null or char_length(reason) <= 500),
  performed_by        uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now()
);

create index attendance_corrections_created_idx on public.attendance_corrections (created_at desc);

-- -----------------------------------------------------------------------------
-- Single-row "signal" table so scanner tablets can learn about active-event
-- changes through Realtime without being able to read the events table.
-- -----------------------------------------------------------------------------
create table public.active_event_state (
  id         smallint primary key default 1 check (id = 1),
  event_id   bigint,
  changed_at timestamptz not null default now()
);

insert into public.active_event_state (id, event_id) values (1, null);

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger events_set_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

create trigger attendees_set_updated_at
  before update on public.attendees
  for each row execute function public.set_updated_at();

-- Normalise registration text: trim everything, store blank optionals as NULL.
create or replace function public.normalise_attendee()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.qr_code    := btrim(new.qr_code);
  new.name       := btrim(new.name);
  new.id_number  := nullif(btrim(new.id_number), '');
  new.email      := nullif(lower(btrim(new.email)), '');
  new.department := nullif(btrim(new.department), '');
  return new;
end;
$$;

create trigger attendees_normalise
  before insert or update on public.attendees
  for each row execute function public.normalise_attendee();

-- Attendance rows are immutable once written: the original scanned_at can never
-- be overwritten (corrections are done by an audited delete + re-check-in).
create or replace function public.prevent_attendance_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'attendance records are immutable'
    using errcode = '55000';
end;
$$;

create trigger attendance_immutable
  before update on public.attendance
  for each row execute function public.prevent_attendance_update();

-- Keep active_event_state in sync with the events table.
create or replace function public.sync_active_event_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.active_event_state
     set event_id   = (select e.id from public.events e where e.active limit 1),
         changed_at = now()
   where id = 1;
  return null;
end;
$$;

revoke execute on function public.sync_active_event_state() from public;

create trigger events_sync_active_state
  after insert or update or delete on public.events
  for each statement execute function public.sync_active_event_state();
