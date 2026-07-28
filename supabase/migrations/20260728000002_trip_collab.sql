-- Editable + collaborative trips.
-- Owners and invited members can view and edit a trip; joining happens by
-- entering a short invite code (no deep links needed pre-launch).

alter table public.trip_plans
  add column title text,
  add column start_date date,
  add column invite_code text not null unique
    default upper(substr(md5(gen_random_uuid()::text), 1, 6));

create table public.trip_members (
  trip_id uuid not null references public.trip_plans (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
alter table public.trip_members enable row level security;

-- SECURITY DEFINER helpers avoid RLS policy recursion between the two tables.
create or replace function public.is_trip_member(trip uuid)
returns boolean language sql security definer set search_path = public as
$$ select exists (select 1 from trip_members where trip_id = trip and user_id = auth.uid()) $$;

create or replace function public.is_trip_owner(trip uuid)
returns boolean language sql security definer set search_path = public as
$$ select exists (select 1 from trip_plans where id = trip and user_id = auth.uid()) $$;

create policy "trip_plans: read as member" on public.trip_plans
  for select using (public.is_trip_member(id));
create policy "trip_plans: insert own" on public.trip_plans
  for insert with check (auth.uid() = user_id);
create policy "trip_plans: update own or member" on public.trip_plans
  for update using (auth.uid() = user_id or public.is_trip_member(id))
  with check (auth.uid() = user_id or public.is_trip_member(id));

create policy "trip_members: read" on public.trip_members
  for select using (auth.uid() = user_id or public.is_trip_owner(trip_id));
create policy "trip_members: leave or remove" on public.trip_members
  for delete using (auth.uid() = user_id or public.is_trip_owner(trip_id));

-- Join a trip by code. DEFINER so the code lookup can see the row before
-- membership exists; the code itself is the authorization.
create or replace function public.join_trip(code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select id into t from trip_plans where invite_code = upper(trim(code));
  if t is null then raise exception 'invalid_code'; end if;
  insert into trip_members (trip_id, user_id) values (t, auth.uid())
    on conflict do nothing;
  return t;
end $$;
