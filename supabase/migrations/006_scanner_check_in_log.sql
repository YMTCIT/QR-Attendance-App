-- =============================================================================
-- 006 — Check-in log for the scanner screen
-- -----------------------------------------------------------------------------
-- The scanner page shows a live list of who has checked in to the ACTIVE
-- event, newest first. Scanner accounts still cannot read the attendees or
-- attendance tables; this function exposes only what is displayed on the
-- tablet: the attendee's name and check-in time. No QR codes, IDs, emails or
-- departments.
-- =============================================================================

create or replace function public.get_recent_check_ins(p_limit integer default 50)
returns table (attendance_id bigint, name text, scanned_at timestamptz, total bigint)
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
    select at.id, a.name, at.scanned_at, count(*) over ()
      from public.attendance at
      join public.attendees a on a.id = at.attendee_id
      join public.events e on e.id = at.event_id
     where e.active
     order by at.scanned_at desc, at.id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke execute on function public.get_recent_check_ins(integer) from public, anon, authenticated;
grant execute on function public.get_recent_check_ins(integer) to authenticated;
