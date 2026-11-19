-- Optional demo data for LOCAL development (`supabase db reset` runs this).
-- Do NOT run against production. No attendance rows are created here.

-- Events are created inactive; an administrator activates one from the dashboard.
insert into public.events (name, date, venue)
values ('CIT University Event', current_date, 'CIT-U Gymnasium');

insert into public.attendees (qr_code, name, id_number, email, department, event_id, source) values
  ('ABC001', 'Juan Dela Cruz',  '20260001', 'juan.delacruz@example.edu', 'BSIT', null, 'manual'),
  ('ABC002', 'Maria Santos',    '20260002', 'maria.santos@example.edu',  'BSCS', null, 'manual'),
  ('ABC003', 'Pedro Reyes',     '20260003', 'pedro.reyes@example.edu',   'BSIT', null, 'manual');
