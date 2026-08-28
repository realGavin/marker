-- HOTFIX: grant service_role USAGE on schema private.
--
-- Symptom: every plan-trip create returned 500 save_failed against the
-- deployed function. PostgREST's real error was
--   42501 "permission denied for schema private"
-- Verified by reproducing the function's exact INSERT body twice: it fails
-- with the service key and succeeds, unchanged, with a user JWT.
--
-- Cause. 20260808000001 created the private schema and granted usage to
-- exactly two roles:
--     revoke all on schema private from public;
--     grant usage on schema private to anon, authenticated;
-- service_role was never included, and until now that was invisible. Every
-- earlier caller into private.* was a SECURITY DEFINER function owned by
-- postgres, which executes as its owner and so never needs the caller to hold
-- usage. 20260828000003's trip_plans_conversation_guard is the first PLAIN
-- (non-DEFINER) function to call private.is_service_role(), and a plain
-- trigger function runs as the CALLING role. So the guard installed to protect
-- server-owned columns became the thing that blocked the server from writing
-- them, while ordinary authenticated writes sailed through -- the opposite of
-- the intended asymmetry, and the reason this looked like a save bug rather
-- than a permissions one.
--
-- Why the grant rather than making the trigger SECURITY DEFINER: plain is the
-- safer shape for a trigger (a DEFINER trigger runs as postgres for every
-- writer, which is a much larger surface to reason about), and it is what lets
-- private.is_service_role() read the JWT role claim rather than current_user.
-- The grant restores the property the schema always assumed: private holds
-- helpers for trusted server-side code, and service_role IS the trusted
-- server-side role. It grants usage on the SCHEMA only -- no function or table
-- privileges follow from it, and public stays revoked.
--
-- Scope of the outage this fixes: every service-role write to trip_plans, i.e.
-- plan-trip create, refine and undo. Client writes (useCreateTrip, template
-- adoption) and the SECURITY DEFINER RPCs (adopt_trip, publish_trip, join_trip,
-- vote_trip, rotate_invite_code) were never affected.

begin;

grant usage on schema private to service_role;

commit;
