-- Personal visit-time bookings ("tee times" in the golf skin): user-entered
-- reminders for an upcoming visit to a place. Owner-only via RLS, like all
-- user tables. Reminders themselves are local notifications on the device.
create table public.visit_times (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  place_id uuid not null references public.places (id) on delete cascade,
  at timestamptz not null,
  created_at timestamptz not null default now()
);

create index visit_times_user_idx on public.visit_times (user_id, at);

alter table public.visit_times enable row level security;

create policy "own visit_times select" on public.visit_times
  for select using (auth.uid() = user_id);
create policy "own visit_times insert" on public.visit_times
  for insert with check (auth.uid() = user_id);
create policy "own visit_times delete" on public.visit_times
  for delete using (auth.uid() = user_id);
