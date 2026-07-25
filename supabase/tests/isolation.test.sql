-- Cross-user isolation test. Run with: supabase test db  (uses pgTAP)
-- Proves RLS denies cross-user reads/writes even with direct SQL.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

-- two fake users
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.local');

-- a place to log (service-role context here bypasses RLS, as ETL does)
insert into public.places (id, niche_id, slug, name, location, source)
values ('00000000-0000-0000-0000-0000000000f1'::uuid, 'golf', 'test-place', 'Test Place',
        st_point(-122.4, 37.7)::geography, 'manual');

-- user A logs it
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
insert into public.place_logs (user_id, place_id, status, rating)
values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f1', 'visited', 18);

select is(
  (select count(*)::int from public.place_logs), 1,
  'A sees own log');

-- switch to user B
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}';

select is(
  (select count(*)::int from public.place_logs), 0,
  'B cannot see A''s logs');

select is(
  (select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-00000000000a'), 0,
  'B cannot see A''s profile');

select throws_ok(
  $$insert into public.place_logs (user_id, place_id, status)
    values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f1', 'want')$$,
  '42501', null,
  'B cannot write a log as A');

select throws_ok(
  $$insert into public.entitlements (user_id, tier)
    values ('00000000-0000-0000-0000-00000000000b', 'pro')$$,
  '42501', null,
  'clients cannot self-grant pro');

select is(
  (select count(*)::int from public.places), 1,
  'catalog is publicly readable');

select * from finish();
rollback;
