-- =============================================================================
-- MANUAL two-session concurrency check (run against a STAGING / local DB).
--
-- Proves that two tablets scanning the same QR at the same instant create
-- exactly ONE attendance row. Open two SQL sessions (e.g. two psql windows,
-- or two Supabase SQL editor tabs using a direct connection) as a role that
-- may execute record_qr_check_in (postgres or service_role).
--
-- Prerequisites: an active event, a registrant with qr_code 'ABC001' eligible
-- for it, and a scanner user id (replace <SCANNER_UUID>).
-- =============================================================================

-- SESSION A
begin;
select public.record_qr_check_in('ABC001', '<SCANNER_UUID>');   -- returns {"status":"ok", ...}
-- (do NOT commit yet)

-- SESSION B (while A is still open)
begin;
select public.record_qr_check_in('ABC001', '<SCANNER_UUID>');   -- BLOCKS, waiting on A's unique-key insert

-- SESSION A
commit;

-- SESSION B now returns {"status":"already", "scanned_at": <A's timestamp>}
commit;

-- Verify: exactly one row, original timestamp kept.
select count(*), min(scanned_at), max(scanned_at)
  from public.attendance at
  join public.attendees a on a.id = at.attendee_id
 where a.qr_code = 'ABC001'
   and at.event_id = (select id from public.events where active);
-- Expected: count = 1, min = max

-- Clean up the test check-in afterwards (as an admin, via the dashboard's
-- "Undo check-in", or):
-- delete from public.attendance where attendee_id = (select id from public.attendees where qr_code = 'ABC001');
