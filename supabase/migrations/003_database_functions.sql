-- =============================================================================
-- CIT QR Attendance System — 003 Database functions
--
-- Every privileged function:
--   * uses SET search_path = '' and schema-qualified names,
--   * checks the caller's role itself (defence in depth on top of grants),
--   * has EXECUTE revoked from PUBLIC/anon and granted explicitly.
-- =============================================================================

-- Advisory-lock key that serialises "which event is active" against check-ins.
-- Check-ins take it SHARED, activation switches take it EXCLUSIVE, so a
-- check-in is always recorded against an event that stayed active for the
-- whole transaction.
-- (7310001 is an arbitrary constant used only by this application.)

-- -----------------------------------------------------------------------------
-- set_active_event: atomically make one event active (or none when NULL).
-- -----------------------------------------------------------------------------
create or replace function public.set_active_event(p_event_id bigint)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(7310001);

  if p_event_id is not null
     and not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'event % not found', p_event_id using errcode = 'P0002';
  end if;

  -- Deactivate first, then activate, inside one transaction: the partial
  -- unique index is never violated and other sessions never observe two
  -- active events (or a half-finished switch).
  update public.events
     set active = false
   where active
     and (p_event_id is null or id <> p_event_id);

  if p_event_id is not null then
    update public.events set active = true where id = p_event_id and not active;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- get_active_event: minimum event details for any enabled staff member.
-- -----------------------------------------------------------------------------
create or replace function public.get_active_event()
returns table (id bigint, name text, date date, venue text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select e.id, e.name, e.date, e.venue
      from public.events e
     where e.active
     limit 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- record_qr_check_in: the ONLY path for QR attendance.
-- Called by the check-in Edge Function using the service role after it has
-- verified the caller's identity. Re-verifies the role here as well.
--
-- Duplicate prevention relies on UNIQUE(event_id, attendee_id) with
-- ON CONFLICT DO NOTHING — never on a SELECT-then-INSERT sequence — so two
-- tablets scanning simultaneously still produce exactly one row, and the
-- original scanned_at is never modified.
-- -----------------------------------------------------------------------------
create or replace function public.record_qr_check_in(p_qr_code text, p_recorded_by uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code       text := btrim(coalesce(p_qr_code, ''));
  v_event_id   bigint;
  v_event_name text;
  v_att_id     bigint;
  v_att_name   text;
  v_att_event  bigint;
  v_scanned_at timestamptz;
begin
  if p_recorded_by is null or not exists (
       select 1 from public.app_user_roles r
        where r.user_id = p_recorded_by
          and r.role in ('admin', 'scanner')
          and r.disabled_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_code = '' or char_length(v_code) > 512 then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Block a concurrent activation switch until this transaction ends.
  perform pg_advisory_xact_lock_shared(7310001);

  select e.id, e.name into v_event_id, v_event_name
    from public.events e
   where e.active
   limit 1;

  if v_event_id is null then
    return jsonb_build_object('status', 'no_event');
  end if;

  select a.id, a.name, a.event_id into v_att_id, v_att_name, v_att_event
    from public.attendees a
   where a.qr_code = v_code;

  if v_att_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  if v_att_event is not null and v_att_event <> v_event_id then
    return jsonb_build_object('status', 'wrong_event');
  end if;

  insert into public.attendance (event_id, attendee_id, check_in_method, recorded_by)
  values (v_event_id, v_att_id, 'qr', p_recorded_by)
  on conflict (event_id, attendee_id) do nothing
  returning scanned_at into v_scanned_at;

  if v_scanned_at is not null then
    return jsonb_build_object(
      'status', 'ok',
      'name', v_att_name,
      'event_name', v_event_name,
      'scanned_at', v_scanned_at);
  end if;

  -- Conflict: someone (possibly another tablet, a moment ago) already
  -- checked this attendee in. Report the ORIGINAL timestamp, unchanged.
  select at.scanned_at into v_scanned_at
    from public.attendance at
   where at.event_id = v_event_id and at.attendee_id = v_att_id;

  return jsonb_build_object(
    'status', 'already',
    'name', v_att_name,
    'event_name', v_event_name,
    'scanned_at', v_scanned_at);
end;
$$;

-- -----------------------------------------------------------------------------
-- admin_mark_present: manual check-in by an administrator (audited).
-- -----------------------------------------------------------------------------
create or replace function public.admin_mark_present(
  p_event_id bigint,
  p_attendee_id bigint,
  p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_att_name   text;
  v_att_event  bigint;
  v_scanned_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'event not found' using errcode = 'P0002';
  end if;

  select a.name, a.event_id into v_att_name, v_att_event
    from public.attendees a where a.id = p_attendee_id;

  if v_att_name is null then
    raise exception 'attendee not found' using errcode = 'P0002';
  end if;

  if v_att_event is not null and v_att_event <> p_event_id then
    return jsonb_build_object('status', 'wrong_event');
  end if;

  insert into public.attendance (event_id, attendee_id, check_in_method, recorded_by)
  values (p_event_id, p_attendee_id, 'manual', auth.uid())
  on conflict (event_id, attendee_id) do nothing
  returning scanned_at into v_scanned_at;

  if v_scanned_at is null then
    select at.scanned_at into v_scanned_at
      from public.attendance at
     where at.event_id = p_event_id and at.attendee_id = p_attendee_id;
    return jsonb_build_object('status', 'already', 'name', v_att_name, 'scanned_at', v_scanned_at);
  end if;

  insert into public.attendance_corrections
    (action, event_id, attendee_id, attendee_name, original_scanned_at, reason, performed_by)
  values
    ('manual_check_in', p_event_id, p_attendee_id, v_att_name, null,
     left(nullif(btrim(p_reason), ''), 500), auth.uid());

  return jsonb_build_object('status', 'ok', 'name', v_att_name, 'scanned_at', v_scanned_at);
end;
$$;

-- -----------------------------------------------------------------------------
-- admin_undo_check_in: remove an incorrect check-in (audited).
-- -----------------------------------------------------------------------------
create or replace function public.admin_undo_check_in(
  p_attendance_id bigint,
  p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row  public.attendance%rowtype;
  v_name text;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from public.attendance at
   where at.id = p_attendance_id
  returning at.* into v_row;

  if v_row.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select a.name into v_name from public.attendees a where a.id = v_row.attendee_id;

  insert into public.attendance_corrections
    (action, event_id, attendee_id, attendee_name, original_scanned_at, reason, performed_by)
  values
    ('undo_check_in', v_row.event_id, v_row.attendee_id, v_name, v_row.scanned_at,
     left(nullif(btrim(p_reason), ''), 500), auth.uid());

  return jsonb_build_object('status', 'ok');
end;
$$;

-- -----------------------------------------------------------------------------
-- event_stats: Registered / Present for one event (admin only).
--   Registered = attendees eligible for the event (event_id = E or NULL)
--   Present    = eligible attendees holding a check-in for E
-- -----------------------------------------------------------------------------
create or replace function public.event_stats(p_event_id bigint)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_registered bigint;
  v_present    bigint;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select count(*) into v_registered
    from public.attendees a
   where a.event_id = p_event_id or a.event_id is null;

  select count(*) into v_present
    from public.attendance at
    join public.attendees a on a.id = at.attendee_id
   where at.event_id = p_event_id
     and (a.event_id = p_event_id or a.event_id is null);

  return jsonb_build_object('registered', v_registered, 'present', v_present);
end;
$$;

-- -----------------------------------------------------------------------------
-- event_roster: every eligible attendee for an event plus check-in status.
-- (Admin only; RLS applies as SECURITY INVOKER.) Page with .range().
-- -----------------------------------------------------------------------------
create or replace function public.event_roster(p_event_id bigint)
returns table (
  attendee_id     bigint,
  name            text,
  id_number       text,
  email           text,
  department      text,
  attendee_event  bigint,
  attendance_id   bigint,
  scanned_at      timestamptz,
  check_in_method text)
language sql
stable
security invoker
set search_path = ''
as $$
  select a.id, a.name, a.id_number, a.email, a.department, a.event_id,
         at.id, at.scanned_at, at.check_in_method
    from public.attendees a
    left join public.attendance at
           on at.attendee_id = a.id and at.event_id = p_event_id
   where (select public.is_admin())
     and (a.event_id = p_event_id or a.event_id is null)
   order by a.name, a.id;
$$;

-- -----------------------------------------------------------------------------
-- event_registrant_counts: eligible registrants per event (admin only).
-- -----------------------------------------------------------------------------
create or replace function public.event_registrant_counts()
returns table (event_id bigint, registrants bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with any_event as (
    select count(*) as n from public.attendees a where a.event_id is null
  ), specific as (
    select a.event_id, count(*) as n from public.attendees a
     where a.event_id is not null group by a.event_id
  )
  select e.id, coalesce(s.n, 0) + (select n from any_event)
    from public.events e
    left join specific s on s.event_id = e.id
   where (select public.is_admin());
$$;

-- -----------------------------------------------------------------------------
-- admin_lookup_registrants: which of these QR codes already exist?
-- Used by the importer to warn before an attendee's event changes.
-- -----------------------------------------------------------------------------
create or replace function public.admin_lookup_registrants(p_codes text[])
returns table (qr_code text, name text, event_id bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(array_length(p_codes, 1), 0) > 5000 then
    raise exception 'too many codes in one lookup' using errcode = '22023';
  end if;

  return query
    select a.qr_code, a.name, a.event_id
      from public.attendees a
     where a.qr_code = any (p_codes);
end;
$$;

-- -----------------------------------------------------------------------------
-- admin_upsert_registrants: batch registration upsert keyed on qr_code.
--   * NEVER touches the attendance table.
--   * Blank optional cells do not erase existing values.
--   * Keeps the original registration source and created_at.
-- Returns {"inserted": n, "updated": m}.
-- -----------------------------------------------------------------------------
create or replace function public.admin_upsert_registrants(
  p_rows jsonb,
  p_source text default 'import')
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_inserted bigint;
  v_updated  bigint;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_source not in ('import', 'manual') then
    raise exception 'invalid source' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'rows must be an array of at most 1000 items' using errcode = '22023';
  end if;

  with input as (
    select x.qr_code, x.name, x.id_number, x.email, x.department, x.event_id
      from jsonb_to_recordset(p_rows) as x(
        qr_code text, name text, id_number text, email text,
        department text, event_id bigint)
  ), up as (
    insert into public.attendees as t
      (qr_code, name, id_number, email, department, event_id, source)
    select i.qr_code, i.name, i.id_number, i.email, i.department, i.event_id, p_source
      from input i
    on conflict (qr_code) do update
      set name       = excluded.name,
          id_number  = coalesce(excluded.id_number, t.id_number),
          email      = coalesce(excluded.email, t.email),
          department = coalesce(excluded.department, t.department),
          event_id   = excluded.event_id
    returning (t.xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted),
         count(*) filter (where not was_inserted)
    into v_inserted, v_updated
    from up;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated);
end;
$$;

-- -----------------------------------------------------------------------------
-- integration_upsert_registrant: used ONLY by the register-attendee Edge
-- Function (Power Automate) via the service role. Retries with the same QR
-- code update the same row instead of creating duplicates.
-- -----------------------------------------------------------------------------
create or replace function public.integration_upsert_registrant(
  p_qr_code text,
  p_name text,
  p_id_number text,
  p_email text,
  p_department text,
  p_event_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id       bigint;
  v_inserted boolean;
begin
  if p_event_id is not null
     and not exists (select 1 from public.events e where e.id = p_event_id) then
    return jsonb_build_object('status', 'unknown_event');
  end if;

  insert into public.attendees as t
    (qr_code, name, id_number, email, department, event_id, source)
  values
    (p_qr_code, p_name, p_id_number, p_email, p_department, p_event_id, 'power_automate')
  on conflict (qr_code) do update
    set name       = excluded.name,
        id_number  = coalesce(excluded.id_number, t.id_number),
        email      = coalesce(excluded.email, t.email),
        department = coalesce(excluded.department, t.department),
        event_id   = excluded.event_id
  returning t.id, (t.xmax = 0) into v_id, v_inserted;

  return jsonb_build_object('status', 'ok', 'id', v_id, 'created', v_inserted);
end;
$$;

-- -----------------------------------------------------------------------------
-- EXECUTE grants
-- -----------------------------------------------------------------------------
revoke execute on function public.set_active_event(bigint)                          from public, anon, authenticated;
revoke execute on function public.get_active_event()                                from public, anon, authenticated;
revoke execute on function public.record_qr_check_in(text, uuid)                    from public, anon, authenticated;
revoke execute on function public.admin_mark_present(bigint, bigint, text)          from public, anon, authenticated;
revoke execute on function public.admin_undo_check_in(bigint, text)                 from public, anon, authenticated;
revoke execute on function public.event_stats(bigint)                               from public, anon, authenticated;
revoke execute on function public.event_roster(bigint)                              from public, anon, authenticated;
revoke execute on function public.event_registrant_counts()                         from public, anon, authenticated;
revoke execute on function public.admin_lookup_registrants(text[])                  from public, anon, authenticated;
revoke execute on function public.admin_upsert_registrants(jsonb, text)             from public, anon, authenticated;
revoke execute on function public.integration_upsert_registrant(text, text, text, text, text, bigint)
  from public, anon, authenticated;

-- Staff-callable (each re-checks the role internally).
grant execute on function public.set_active_event(bigint)                 to authenticated;
grant execute on function public.get_active_event()                       to authenticated;
grant execute on function public.admin_mark_present(bigint, bigint, text) to authenticated;
grant execute on function public.admin_undo_check_in(bigint, text)        to authenticated;
grant execute on function public.event_stats(bigint)                      to authenticated;
grant execute on function public.event_roster(bigint)                     to authenticated;
grant execute on function public.event_registrant_counts()                to authenticated;
grant execute on function public.admin_lookup_registrants(text[])         to authenticated;
grant execute on function public.admin_upsert_registrants(jsonb, text)    to authenticated;

-- Server-side only (Edge Functions using the service role).
grant execute on function public.record_qr_check_in(text, uuid) to service_role;
grant execute on function public.integration_upsert_registrant(text, text, text, text, text, bigint)
  to service_role;
