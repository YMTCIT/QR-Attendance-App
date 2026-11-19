-- =============================================================================
-- CIT QR Attendance System — 002 Security: role helpers, grants, RLS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Role helper functions.
-- SECURITY DEFINER so they can read app_user_roles regardless of the caller's
-- RLS, with an explicit empty search_path so they cannot be hijacked.
-- -----------------------------------------------------------------------------
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.role
    from public.app_user_roles r
   where r.user_id = (select auth.uid())
     and r.disabled_at is null;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.app_role() = 'admin', false);
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.app_role() in ('admin', 'scanner'), false);
$$;

revoke execute on function public.app_role() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.app_role() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_staff() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Table privileges. Supabase grants broad defaults to anon/authenticated;
-- tighten them first, then grant only what RLS policies are written for.
-- Anonymous visitors get NOTHING.
-- -----------------------------------------------------------------------------
revoke all on table
  public.app_user_roles,
  public.events,
  public.attendees,
  public.attendance,
  public.import_logs,
  public.attendance_corrections,
  public.active_event_state
from anon, authenticated;

grant select                         on public.app_user_roles         to authenticated;
grant select, insert, update, delete on public.events                 to authenticated;
grant select, insert, update, delete on public.attendees              to authenticated;
-- Attendance is written only through audited functions (003) — never directly.
grant select                         on public.attendance             to authenticated;
grant select, insert                 on public.import_logs            to authenticated;
grant select                         on public.attendance_corrections to authenticated;
grant select                         on public.active_event_state     to authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.app_user_roles         enable row level security;
alter table public.events                 enable row level security;
alter table public.attendees              enable row level security;
alter table public.attendance             enable row level security;
alter table public.import_logs            enable row level security;
alter table public.attendance_corrections enable row level security;
alter table public.active_event_state     enable row level security;

-- app_user_roles: a user may read their own role; admins may read all.
-- No INSERT/UPDATE/DELETE policy: nobody can assign or change roles through
-- the public API (prevents self-promotion). Role writes happen only in the
-- manage-scanner-users Edge Function (service role) or owner-run SQL.
create policy "roles: read own or admin reads all"
  on public.app_user_roles for select
  to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- events: admins have full access. Scanner users read the active event only
-- through public.get_active_event() (003), which returns the minimum fields.
create policy "events: admin select"
  on public.events for select to authenticated
  using ((select public.is_admin()));
create policy "events: admin insert"
  on public.events for insert to authenticated
  with check ((select public.is_admin()));
create policy "events: admin update"
  on public.events for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
create policy "events: admin delete"
  on public.events for delete to authenticated
  using ((select public.is_admin()));

-- attendees: admin only. Scanner users can NEVER read registrant records;
-- the check-in Edge Function returns only the attendee's name.
create policy "attendees: admin select"
  on public.attendees for select to authenticated
  using ((select public.is_admin()));
create policy "attendees: admin insert"
  on public.attendees for insert to authenticated
  with check ((select public.is_admin()));
create policy "attendees: admin update"
  on public.attendees for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
create policy "attendees: admin delete"
  on public.attendees for delete to authenticated
  using ((select public.is_admin()));

-- attendance: admins may read. Writes only via security-definer functions.
create policy "attendance: admin select"
  on public.attendance for select to authenticated
  using ((select public.is_admin()));

-- import_logs: admins read all and may insert logs attributed to themselves.
create policy "import_logs: admin select"
  on public.import_logs for select to authenticated
  using ((select public.is_admin()));
create policy "import_logs: admin insert own"
  on public.import_logs for insert to authenticated
  with check ((select public.is_admin()) and imported_by = (select auth.uid()));

-- attendance_corrections: admin read-only (rows written by functions).
create policy "attendance_corrections: admin select"
  on public.attendance_corrections for select to authenticated
  using ((select public.is_admin()));

-- active_event_state: any enabled staff member (admin or scanner). It only
-- exposes the active event's numeric id and a timestamp.
create policy "active_event_state: staff select"
  on public.active_event_state for select to authenticated
  using ((select public.is_staff()));
