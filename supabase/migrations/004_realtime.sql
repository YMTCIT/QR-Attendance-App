-- =============================================================================
-- CIT QR Attendance System — 004 Realtime
--
-- Supabase Realtime "postgres_changes" respects RLS, so:
--   * admins receive attendance / attendees / events changes,
--   * scanner users receive ONLY active_event_state changes (an event id and a
--     timestamp) and then re-fetch details through get_active_event().
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array['attendance', 'attendees', 'events', 'active_event_state']
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
