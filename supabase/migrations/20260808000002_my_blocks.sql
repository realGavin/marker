-- my_blocks(): the caller's own block list, with handles.
--
-- WHY this needs a function at all: "user_blocks: read own" lets a user select
-- their own rows, but those rows carry only blocked_id. profiles is read-own,
-- so the client cannot join a handle onto them — a blocked-accounts screen
-- would show a column of raw uuids. Without it, blocking is a one-way door:
-- the app can create a block and never undo it.
--
-- This is a legitimate public RPC (unlike the private.* helpers, which take
-- arbitrary uuids and were moved out of PostgREST's reach). It takes NO
-- arguments and reads auth.uid() itself, so a caller can only ever describe
-- their own block list — there is no parameter to point at someone else.
create or replace function public.my_blocks()
returns table (blocked_id uuid, handle text, created_at timestamptz)
language sql stable security definer
set search_path = public, private, pg_temp as $$
  select b.blocked_id, p.handle, b.created_at
  from user_blocks b
  left join profiles p on p.id = b.blocked_id   -- left: a deleted account still unblocks
  where b.blocker_id = auth.uid()               -- the only row filter that matters
    and auth.uid() is not null                  -- anon gets an empty set, not everyone's
  order by b.created_at desc
$$;

-- EXECUTE stays at the PUBLIC default: the function is self-scoping, and an
-- anonymous caller gets zero rows because auth.uid() is null.
