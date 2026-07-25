-- Marker core schema. Niche-agnostic tables; niche facts live in places.attrs.
-- Every user table: RLS ON, default deny, owner-only policies.

create extension if not exists postgis;
create extension if not exists vector;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text check (char_length(display_name) between 1 and 50),
  home_region text,
  niche_id text not null default 'golf',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ---------------------------------------------------------------- places
-- Public catalog, read-only to clients; written only by ETL via service role.
create table public.places (
  id uuid primary key default gen_random_uuid(),
  niche_id text not null,
  slug text not null,
  name text not null,
  location geography (point, 4326) not null,
  city text,
  region text,
  country text not null default 'US',
  attrs jsonb not null default '{}'::jsonb,
  description text,
  embedding vector (1024),
  source text not null,          -- provenance: 'osm' | 'overture' | 'manual'
  source_ref text,               -- upstream id for re-sync
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (niche_id, slug)
);

create index places_location_idx on public.places using gist (location);
create index places_niche_region_idx on public.places (niche_id, country, region);

alter table public.places enable row level security;

create policy "places: public read" on public.places
  for select using (true);
-- no insert/update/delete policies: only service role (bypasses RLS) writes.

-- ---------------------------------------------------------------- place_logs
create table public.place_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  place_id uuid not null references public.places (id) on delete cascade,
  status text not null check (status in ('visited', 'want')),
  rating smallint check (rating between 0 and 20), -- halves: 0–10 in 0.5 steps
  note text check (char_length(note) <= 2000),
  visited_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, place_id)
);

create index place_logs_user_idx on public.place_logs (user_id);

alter table public.place_logs enable row level security;

create policy "place_logs: crud own" on public.place_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------- lists
create table public.lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles (id) on delete cascade, -- null = system/curated
  slug text,                    -- stable id for curated lists
  title text not null check (char_length(title) between 1 and 80),
  description text check (char_length(description) <= 500),
  niche_id text not null default 'golf',
  created_at timestamptz not null default now(),
  unique (niche_id, slug)
);

alter table public.lists enable row level security;

create policy "lists: read own or curated" on public.lists
  for select using (owner_id is null or auth.uid() = owner_id);
create policy "lists: insert own" on public.lists
  for insert with check (auth.uid() = owner_id);
create policy "lists: update own" on public.lists
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "lists: delete own" on public.lists
  for delete using (auth.uid() = owner_id);

create table public.list_items (
  list_id uuid not null references public.lists (id) on delete cascade,
  place_id uuid not null references public.places (id) on delete cascade,
  position int not null default 0,
  primary key (list_id, place_id)
);

alter table public.list_items enable row level security;

-- items follow their list's visibility/ownership
create policy "list_items: read via list" on public.list_items
  for select using (
    exists (
      select 1 from public.lists l
      where l.id = list_id and (l.owner_id is null or l.owner_id = auth.uid())
    )
  );
create policy "list_items: write via owned list" on public.list_items
  for all using (
    exists (select 1 from public.lists l where l.id = list_id and l.owner_id = auth.uid())
  )
  with check (
    exists (select 1 from public.lists l where l.id = list_id and l.owner_id = auth.uid())
  );

-- ---------------------------------------------------------------- entitlements
-- Written ONLY by the RevenueCat webhook (service role). Clients read own row.
create table public.entitlements (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'pro')),
  expires_at timestamptz,
  rc_app_user_id text,
  updated_at timestamptz not null default now()
);

alter table public.entitlements enable row level security;

create policy "entitlements: read own" on public.entitlements
  for select using (auth.uid() = user_id);
-- no client write policies by design.

-- ---------------------------------------------------------------- trip_plans
create table public.trip_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  request jsonb not null,      -- structured constraints as parsed
  itinerary jsonb not null,    -- validated plan: days -> place ids + text
  created_at timestamptz not null default now()
);

create index trip_plans_user_idx on public.trip_plans (user_id);

alter table public.trip_plans enable row level security;

create policy "trip_plans: read own" on public.trip_plans
  for select using (auth.uid() = user_id);
create policy "trip_plans: delete own" on public.trip_plans
  for delete using (auth.uid() = user_id);
-- inserts happen in the plan-trip Edge Function (service role) after validation.

-- ---------------------------------------------------------------- updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger place_logs_updated before update on public.place_logs
  for each row execute function public.set_updated_at();
create trigger places_updated before update on public.places
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- auto-profile
-- Create a profile row when a user signs up (handle chosen later in onboarding).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.entitlements (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
