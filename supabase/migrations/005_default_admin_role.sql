-- =============================================================================
-- 005 — Every Supabase Auth user gets the admin role by default
-- -----------------------------------------------------------------------------
-- Public sign-up is disabled, so the only way into auth.users is an account
-- created by the project owner (Dashboard → Authentication → Users) or by an
-- admin in the app. Every such account can therefore sign in and use the app
-- without a separate SQL step.
--
-- Scanner accounts created from the app (manage-scanner-users) are switched to
-- the 'scanner' role straight after creation, so they keep their restricted
-- access. Disabling a scanner still works as before.
-- =============================================================================

create or replace function public.assign_default_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.app_user_roles (user_id, role)
  values (new.id, 'admin')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke execute on function public.assign_default_role() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_assign_role on auth.users;
create trigger on_auth_user_created_assign_role
  after insert on auth.users
  for each row execute function public.assign_default_role();

-- Existing users that have no role yet become admins too.
insert into public.app_user_roles (user_id, role)
select id, 'admin' from auth.users
on conflict (user_id) do nothing;
