import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LogStatus } from "@marker/core";
import { getSupabase } from "./supabase";
import { skin } from "../skin";
import { useAuth } from "../providers/auth";

export interface PlaceDetail {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  region: string | null;
  attrs: unknown;
  description: string | null;
}

export interface MyLog {
  place_id: string;
  status: LogStatus;
  rating: number | null; // 0-20 halves
  note: string | null;
  place: { slug: string; name: string; city: string | null; region: string | null };
}

export interface ListSummary {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  owner_id: string | null;
  itemCount: number;
}

const sb = () => {
  const s = getSupabase();
  if (!s) throw new Error("backend not configured");
  return s;
};

export function usePlace(slug: string) {
  return useQuery({
    queryKey: ["place", slug],
    queryFn: async (): Promise<PlaceDetail | null> => {
      const { data, error } = await sb()
        .from("places")
        .select("id,slug,name,city,region,attrs,description")
        .eq("niche_id", skin.nicheId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export interface Profile {
  id: string;
  handle: string | null;
  display_name: string | null;
  home_region: string | null;
}

export function useProfile() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["profile", session?.user.id],
    enabled: !!session,
    queryFn: async (): Promise<Profile | null> => {
      const { data, error } = await sb()
        .from("profiles")
        .select("id,handle,display_name,home_region")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (patch: Partial<Pick<Profile, "handle" | "display_name" | "home_region">>) => {
      if (!session) throw new Error("not signed in");
      const { error } = await sb().from("profiles").update(patch).eq("id", session.user.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }),
  });
}

/** All of the signed-in user's logs, joined with place basics. */
export function useMyLogs() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["my-logs", session?.user.id],
    enabled: !!session,
    // Mounted on six screens; own edits invalidate on write, so a longer stale
    // window kills most redundant full-collection refetches on tab switches.
    staleTime: 300_000,
    queryFn: async (): Promise<MyLog[]> => {
      const { data, error } = await sb()
        .from("place_logs")
        .select("place_id,status,rating,note,place:places(slug,name,city,region)")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as MyLog[];
    },
  });
}

export function useUpsertLog() {
  const qc = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (input: { placeId: string; status: LogStatus; rating?: number | null; note?: string | null }) => {
      if (!session) throw new Error("not signed in");
      const { error } = await sb().from("place_logs").upsert(
        {
          user_id: session.user.id,
          place_id: input.placeId,
          status: input.status,
          rating: input.rating ?? null,
          note: input.note ?? null,
        },
        { onConflict: "user_id,place_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-logs"] });
      qc.invalidateQueries({ queryKey: ["list-items"] });
    },
  });
}

export function useDeleteLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (placeId: string) => {
      const { error } = await sb().from("place_logs").delete().eq("place_id", placeId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-logs"] }),
  });
}

/** Curated (system) lists plus the user's own lists, with item counts. */
export function useLists() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["lists", session?.user.id],
    enabled: !!session,
    queryFn: async (): Promise<ListSummary[]> => {
      const { data, error } = await sb()
        .from("lists")
        .select("id,slug,title,description,owner_id,list_items(count)");
      if (error) throw error;
      return (data ?? []).map((l) => ({
        id: l.id,
        slug: l.slug,
        title: l.title,
        description: l.description,
        owner_id: l.owner_id,
        itemCount: (l.list_items as unknown as Array<{ count: number }>)[0]?.count ?? 0,
      }));
    },
  });
}

export interface ListItemRow {
  position: number;
  place: { id: string; slug: string; name: string; city: string | null; region: string | null };
}

export function useListItems(listId: string) {
  return useQuery({
    queryKey: ["list-items", listId],
    queryFn: async (): Promise<ListItemRow[]> => {
      const { data, error } = await sb()
        .from("list_items")
        .select("position,place:places(id,slug,name,city,region)")
        .eq("list_id", listId)
        .order("position");
      if (error) throw error;
      return (data ?? []) as unknown as ListItemRow[];
    },
  });
}

export interface SimilarPlace {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  region: string | null;
  similarity: number;
}

/** Nearest-neighbour places via pgvector RPC; empty until embeddings are loaded. */
export function useSimilarPlaces(placeId: string | undefined) {
  return useQuery({
    queryKey: ["similar", placeId],
    enabled: !!placeId,
    staleTime: 24 * 3600_000, // embeddings are static between batch runs
    queryFn: async (): Promise<SimilarPlace[]> => {
      const { data, error } = await sb().rpc("match_places", { source_place_id: placeId, match_count: 6 });
      if (error) throw error;
      return (data ?? []) as SimilarPlace[];
    },
  });
}

export interface TripDay {
  day: number;
  note: string;
  places: Array<{ id: string; slug: string; name: string; city: string | null; region: string | null }>;
}
export interface TripItinerary {
  summary: string;
  days: TripDay[];
}
export interface TripPlan {
  id: string;
  user_id: string;
  title: string | null;
  start_date: string | null; // YYYY-MM-DD
  invite_code: string;
  request: { region: string; days: number; stops?: number; rounds?: number }; // engine-purity-ignore: legacy DB field name, unused
  itinerary: TripItinerary;
  created_at: string;
}

export function useTripPlans() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["trips", session?.user.id],
    enabled: !!session,
    queryFn: async (): Promise<TripPlan[]> => {
      const { data, error } = await sb()
        .from("trip_plans")
        .select("id,user_id,title,start_date,invite_code,request,itinerary,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TripPlan[];
    },
  });
}

export function useUpdateTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      tripId: string;
      patch: Partial<Pick<TripPlan, "title" | "start_date" | "itinerary">>;
    }) => {
      const { error } = await sb().from("trip_plans").update(input.patch).eq("id", input.tripId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trips"] }),
  });
}

export function useDeleteTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tripId: string) => {
      const { error } = await sb().from("trip_plans").delete().eq("id", tripId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trips"] }),
  });
}

/** Create an owned, editable trip (e.g. adopted from a curated template). */
export function useCreateTrip() {
  const qc = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (input: { title: string; itinerary: TripItinerary }) => {
      if (!session) throw new Error("not signed in");
      const { data, error } = await sb()
        .from("trip_plans")
        .insert({
          user_id: session.user.id,
          title: input.title,
          request: { region: input.title, days: input.itinerary.days.length, stops: 0 },
          itinerary: input.itinerary,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trips"] }),
  });
}

export function useJoinTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const { data, error } = await sb().rpc("join_trip", { code });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trips"] }),
  });
}

/** Resolve a bundled pin to its full place row (for adding stops to a trip). */
export async function fetchPlaceBySlug(slug: string) {
  const { data, error } = await sb()
    .from("places")
    .select("id,slug,name,city,region")
    .eq("niche_id", skin.nicheId)
    .eq("slug", slug)
    .single();
  if (error) throw error;
  return data as { id: string; slug: string; name: string; city: string | null; region: string | null };
}

/** Error codes surfaced by the plan-trip function for UI branching. */
export type PlanTripError = "upgrade_required" | "monthly_limit" | "region_not_found" | "no_places_in_region" | "failed";

export function usePlanTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { region: string; days: number; stops: number; budget: string; notes?: string }) => {
      const { data, error } = await sb().functions.invoke("plan-trip", { body: input });
      if (error) {
        let code: PlanTripError = "failed";
        try {
          const ctx = (error as { context?: Response }).context;
          if (ctx) code = ((await ctx.json()).error as PlanTripError) ?? "failed";
        } catch {
          /* keep generic */
        }
        throw new Error(code);
      }
      return data as { id: string | null; itinerary: TripItinerary };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trips"] }),
  });
}

/** Resolve a template's place slugs to live rows (name/city for display). */
export function useTemplatePlaces(slugs: string[]) {
  return useQuery({
    queryKey: ["template-places", slugs.join(",")],
    staleTime: 24 * 3600_000,
    queryFn: async () => {
      const { data, error } = await sb()
        .from("places")
        .select("id,slug,name,city,region")
        .eq("niche_id", skin.nicheId)
        .in("slug", slugs);
      if (error) throw error;
      const byS = new Map((data ?? []).map((p) => [p.slug, p]));
      return slugs.map((s) => byS.get(s)).filter((p): p is NonNullable<typeof p> => !!p);
    },
  });
}

export function useCreateList() {
  const qc = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (title: string) => {
      if (!session) throw new Error("not signed in");
      const { data, error } = await sb()
        .from("lists")
        .insert({ owner_id: session.user.id, title, niche_id: skin.nicheId })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lists"] }),
  });
}

export function useDeleteList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (listId: string) => {
      const { error } = await sb().from("lists").delete().eq("id", listId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lists"] }),
  });
}

export function useRenameList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { listId: string; title: string }) => {
      const { error } = await sb().from("lists").update({ title: input.title }).eq("id", input.listId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lists"] }),
  });
}

export function useRemoveFromList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { listId: string; placeId: string }) => {
      const { error } = await sb()
        .from("list_items")
        .delete()
        .eq("list_id", input.listId)
        .eq("place_id", input.placeId);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["list-items", v.listId] });
      qc.invalidateQueries({ queryKey: ["lists"] });
    },
  });
}

export function useAddToList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { listId: string; placeId: string }) => {
      const { error } = await sb()
        .from("list_items")
        .upsert({ list_id: input.listId, place_id: input.placeId, position: Date.now() % 1_000_000 });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["list-items", v.listId] });
      qc.invalidateQueries({ queryKey: ["lists"] });
    },
  });
}

/**
 * A scheduled upcoming visit; the skin names these (see vocab.visitTime).
 * Sourced from the `my_visit_times` view, which is scoped to visits the
 * caller owns or has joined. `invite_code` is only populated for the owner
 * (non-owners can't invite further); `travel_minutes` is always the
 * caller's own, never another member's; `member_count` includes the owner
 * so it's always >= 1.
 */
export interface VisitTime {
  id: string;
  place_id: string;
  place_name: string;
  place_slug: string;
  at: string;
  is_owner: boolean;
  invite_code: string | null;
  travel_minutes: number | null;
  member_count: number;
}

/** Error codes the visit-time RPCs (join/leave/set_travel_minutes) can throw. */
export type VisitError =
  | "not_signed_in"
  | "not_found"
  | "not_owner"
  | "already_member"
  | "invalid_minutes"
  | "too_many_attempts"
  | "owner_cannot_leave"
  | "failed";

/**
 * Maps a visit-time RPC's thrown error code to a message worth showing.
 * `context` disambiguates `not_found`: only the join path takes an
 * invite code, so only it should tell the user to check one. `set_travel_minutes`
 * and `leave_visit` raise the same code to mean "this visit was deleted out
 * from under you" — telling that user to check a code they never typed is
 * actively confusing.
 */
export function visitErrorMessage(code: string, context: "join" | "generic" = "generic"): string {
  switch (code as VisitError) {
    case "not_signed_in":
      return "Sign in to do that.";
    case "not_found":
      return context === "join" ? "Check the code and try again." : "This one's gone.";
    case "already_member":
      return "You're already on this one.";
    case "invalid_minutes":
      return "Enter a travel time between 0 and 480 minutes.";
    case "too_many_attempts":
      return "Too many attempts — try again in a bit.";
    case "owner_cannot_leave":
      // The owner can't leave their own visit — they delete it instead, same
      // as before this feature existed.
      return "You created this one — delete it instead of leaving.";
    case "not_owner":
      return "Only the owner can do that.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export function useVisitTimes() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["visit-times", session?.user.id],
    enabled: !!session,
    queryFn: async (): Promise<VisitTime[]> => {
      const { data, error } = await sb()
        .from("my_visit_times")
        .select(
          "id, place_id, place_name, place_slug, at, is_owner, invite_code, travel_minutes, member_count",
        );
      if (error) throw error;
      // The view carries no ORDER BY, so sort client-side — same ascending
      // order every consumer already relies on.
      return ((data as unknown as VisitTime[]) ?? []).sort(
        (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
      );
    },
  });
}

export function useAddVisitTime() {
  const qc = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (input: { placeId: string; at: Date }) => {
      if (!session) throw new Error("not signed in");
      const { data, error } = await sb()
        .from("visit_times")
        .insert({ user_id: session.user.id, place_id: input.placeId, at: input.at.toISOString() })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["visit-times"] }),
  });
}

export function useDeleteVisitTime() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sb().from("visit_times").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["visit-times"] }),
  });
}

/** Sets (or, with `minutes: null`, clears) the caller's own travel time on a visit. */
export function useSetTravelMinutes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; minutes: number | null }) => {
      const { error } = await sb().rpc("set_travel_minutes", {
        visit: input.visitId,
        minutes: input.minutes,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["visit-times"] }),
  });
}

/** Joins someone else's visit by its invite code; returns the visit id. */
export function useJoinVisitTime() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const { data, error } = await sb().rpc("join_visit", { code });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["visit-times"] }),
  });
}

/** Leaves a visit the caller joined (not owns — the owner deletes instead; see owner_cannot_leave). */
export function useLeaveVisitTime() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (visitId: string) => {
      const { error } = await sb().rpc("leave_visit", { visit: visitId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["visit-times"] }),
  });
}

export interface PlaceRatingStats {
  place_id: string;
  avg: number; // 0-20 scale, matching place_logs.rating
  rating_count: number;
}

/** Community average rating for a place; absent until >=3 ratings exist. */
export function usePlaceRating(placeId: string | undefined) {
  return useQuery({
    queryKey: ["place-rating", placeId],
    enabled: !!placeId,
    queryFn: async (): Promise<PlaceRatingStats | null> => {
      try {
        const { data, error } = await sb()
          .from("place_rating_stats")
          .select("place_id,avg,rating_count")
          .eq("place_id", placeId)
          .maybeSingle();
        if (error) throw error;
        return data as PlaceRatingStats | null;
      } catch {
        return null; // hide rather than error
      }
    },
  });
}

export interface RatedPlace {
  slug: string;
  avg: number; // 0-20 scale, matching place_logs.rating
  rating_count: number;
}

/**
 * ALL currently-rated places (>=3 ratings — see the place_rating_stats view)
 * in a single request, joined to their slug so the map can match rows to the
 * bundled pin data (which carries no place id). This set is small by
 * construction, so this is the flat-cost alternative to querying per
 * viewport/pan, which would be an unbounded per-user cost pattern this
 * project forbids. Cached for a long window since the set changes slowly
 * and is fetched once app-wide, not per screen. Fails soft (empty object) so
 * a query error just hides ratings rather than breaking the map.
 *
 * Returns a plain slug-keyed object rather than a Map: the react-query cache
 * is persisted to AsyncStorage via JSON.stringify (see providers/query.tsx),
 * and JSON.stringify(new Map()) serializes to "{}" — a Map rehydrated from
 * disk silently becomes a plain object, so any code doing `.size` or
 * `for...of` on it would crash after the app is killed and reopened. Callers
 * that want Map semantics should build one from this object themselves
 * (e.g. in a useMemo), never store one in query state.
 */
export function useRatedPlaces() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["rated-places"],
    enabled: !!session,
    staleTime: 3600_000, // >=1hr: this list moves slowly; no reason to refetch per visit
    queryFn: async (): Promise<Record<string, RatedPlace>> => {
      try {
        const { data, error } = await sb()
          .from("place_rating_stats")
          .select("place_id,avg,rating_count,place:places(slug)")
          .order("rating_count", { ascending: false })
          // Hard cap, not an accident: place_rating_stats only includes
          // places with >=3 ratings so this is expected to stay far below
          // the limit, but if usage ever saturates it, ordering by
          // rating_count desc keeps the best-established ratings and
          // truncates the long tail rather than growing the payload
          // unbounded.
          .limit(2000);
        if (error) throw error;
        const bySlug: Record<string, RatedPlace> = {};
        for (const row of (data ?? []) as unknown as Array<{
          place_id: string;
          avg: number;
          rating_count: number;
          place: { slug: string } | null;
        }>) {
          if (!row.place?.slug) continue;
          bySlug[row.place.slug] = { slug: row.place.slug, avg: row.avg, rating_count: row.rating_count };
        }
        return bySlug;
      } catch {
        return {}; // hide rather than error
      }
    },
  });
}

/** The three verdicts a single condition report can carry. */
export type ConditionScore = "good" | "ok" | "poor";

export interface ConditionSummary {
  place_id: string;
  kind: string;
  /** DISTINCT reporting users choosing "poor" within the 14-day window. */
  poor_count: number;
  /** DISTINCT reporting users choosing "ok" within the 14-day window. */
  ok_count: number;
  /** DISTINCT reporting users choosing "good" within the 14-day window. */
  good_count: number;
  /** Total distinct reporters within the window (>=2, or this row wouldn't exist). */
  reporters: number;
  /**
   * Distinct users who endorsed ("still true") without filing their own
   * report on this (place, kind) — disjoint from `reporters`, so
   * `reporters + endorsements` is a true headcount, not a double-count.
   */
  endorsements: number;
  latest_note: string | null;
  latest_at: string;
  expires_at: string;
  /** id of the report latest_note/latest_at came from; the endorse target. */
  latest_report_id: string;
}

/**
 * Active, corroborated condition reports for a place — a full poor/ok/good
 * breakdown per aspect, not a single collapsed verdict, so the reader can
 * judge the evidence themselves (see condition_summary: DISTINCT reporters
 * within a 14-day window, gated at >=2 reporters).
 */
export function useConditions(placeId: string | undefined) {
  return useQuery({
    queryKey: ["conditions", placeId],
    enabled: !!placeId,
    queryFn: async (): Promise<ConditionSummary[]> => {
      try {
        const { data, error } = await sb()
          .from("condition_summary")
          .select(
            "place_id,kind,poor_count,ok_count,good_count,reporters,endorsements,latest_note,latest_at,expires_at,latest_report_id",
          )
          .eq("place_id", placeId)
          .order("reporters", { ascending: false });
        if (error) throw error;
        return (data ?? []) as ConditionSummary[];
      } catch {
        return [];
      }
    },
  });
}

export function useReportCondition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { placeId: string; kind: string; score: ConditionScore; note?: string | null }) => {
      const { data, error } = await sb().rpc("report_condition", {
        place: input.placeId,
        kind: input.kind,
        score: input.score,
        note: input.note ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["conditions", v.placeId] });
      // A report can be the one that tips a place over the flag threshold —
      // without this, the place page updates immediately but the map/search
      // indicator (staleTime: 1hr, see useFlaggedPlaces) doesn't catch up
      // for up to an hour.
      qc.invalidateQueries({ queryKey: ["flagged-places"] });
    },
  });
}

export interface FlaggedPlace {
  slug: string;
  /** The kind with the most "poor" reports for this place, not merely the most recent. */
  worstKind: string;
  /** DISTINCT reporters choosing "poor" for worstKind within the 14-day window. */
  poorCount: number;
  /** Total distinct reporters within the window (>=2, or this row wouldn't exist). */
  reporters: number;
  latestAt: string;
}

/**
 * ALL places currently worth a warning, in a single request, keyed by slug —
 * the exact pattern of useRatedPlaces() above, for the same reasons: this
 * must never become a per-row or per-viewport query, and slug is what lets
 * search rows and the bundled map pin data match a row here without
 * resolving a place id first. place_condition_flags only holds one row per
 * place where two or more accounts reported "poor" within the past 14 days,
 * and "poor" is at least the largest bucket — a different, narrower rule
 * than condition_summary's own >=2-reporters floor, and on a different
 * clock than a row's 30-day retention window (expires_at) — so this set is
 * small by construction. Returns a plain slug-keyed object, not
 * a Map: the react-query cache persists through JSON.stringify (see
 * providers/query.tsx), and a Map rehydrated from that silently becomes a
 * plain object, so anything expecting Map semantics would crash after the
 * app is killed and reopened — see the useRatedPlaces doc for the incident
 * this avoids repeating.
 */
export function useFlaggedPlaces() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["flagged-places"],
    enabled: !!session,
    staleTime: 3600_000, // >=1hr: same slow-moving, app-wide fetch cadence as useRatedPlaces
    queryFn: async (): Promise<Record<string, FlaggedPlace>> => {
      try {
        const { data, error } = await sb()
          .from("place_condition_flags")
          .select("slug,worst_kind,poor_count,reporters,latest_at")
          .order("latest_at", { ascending: false })
          // Deliberate cap, not an accident: this table only ever holds
          // places meeting the poor-count flag rule above, so it's small by
          // construction; ordering by freshness keeps the newest flags if
          // usage ever somehow saturates it.
          .limit(2000);
        if (error) throw error;
        const bySlug: Record<string, FlaggedPlace> = {};
        for (const row of (data ?? []) as unknown as Array<{
          slug: string;
          worst_kind: string;
          poor_count: number;
          reporters: number;
          latest_at: string;
        }>) {
          bySlug[row.slug] = {
            slug: row.slug,
            worstKind: row.worst_kind,
            poorCount: row.poor_count,
            reporters: row.reporters,
            latestAt: row.latest_at,
          };
        }
        return bySlug;
      } catch {
        return {}; // hide rather than error
      }
    },
  });
}

export function useEndorseCondition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { placeId: string; reportId: string }) => {
      const { error } = await sb().rpc("endorse_condition", { report: input.reportId });
      if (error) throw error;
    },
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ["conditions", v.placeId] }),
  });
}

export interface PublishedTrip {
  id: string;
  title: string;
  summary: string | null;
  author_handle: string | null;
  author_id: string;
  days: number;
  stops: number;
  votes: number;
  editor_pick: boolean;
  published_at: string;
}

/**
 * Trips other users have published to the community feed. published_trips is
 * granted to authenticated only (its block filter keys off auth.uid(), so an
 * anon read would silently bypass every block) — gated on session for that
 * reason, on top of the usual hide-on-error.
 */
export function usePublishedTrips() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["published-trips"],
    enabled: !!session,
    queryFn: async (): Promise<PublishedTrip[]> => {
      try {
        const { data, error } = await sb()
          .from("published_trips")
          .select("id,title,summary,author_handle,author_id,days,stops,votes,editor_pick,published_at")
          .order("editor_pick", { ascending: false })
          .order("votes", { ascending: false })
          .limit(50);
        if (error) throw error;
        return (data ?? []) as PublishedTrip[];
      } catch {
        return [];
      }
    },
  });
}

export function usePublishTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { tripId: string; title: string; summary: string }) => {
      const { error } = await sb().rpc("publish_trip", {
        trip: input.tripId,
        title: input.title,
        summary: input.summary,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["published-trips"] }),
  });
}

export function useUnpublishTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tripId: string) => {
      const { error } = await sb().rpc("unpublish_trip", { trip: tripId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["published-trips"] }),
  });
}

/** Optimistic +1; rolled back on error, reconciled once the server responds. */
export function useVoteTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tripId: string) => {
      const { error } = await sb().rpc("vote_trip", { trip: tripId });
      if (error) throw error;
    },
    onMutate: async (tripId: string) => {
      await qc.cancelQueries({ queryKey: ["published-trips"] });
      const prev = qc.getQueryData<PublishedTrip[]>(["published-trips"]);
      qc.setQueryData<PublishedTrip[]>(["published-trips"], (old) =>
        (old ?? []).map((t) => (t.id === tripId ? { ...t, votes: t.votes + 1 } : t)),
      );
      return { prev };
    },
    onError: (_err, _tripId, ctx) => {
      if (ctx?.prev) qc.setQueryData(["published-trips"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["published-trips"] }),
  });
}

export function useUnvoteTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tripId: string) => {
      const { error } = await sb().rpc("unvote_trip", { trip: tripId });
      if (error) throw error;
    },
    onMutate: async (tripId: string) => {
      await qc.cancelQueries({ queryKey: ["published-trips"] });
      const prev = qc.getQueryData<PublishedTrip[]>(["published-trips"]);
      qc.setQueryData<PublishedTrip[]>(["published-trips"], (old) =>
        (old ?? []).map((t) => (t.id === tripId ? { ...t, votes: Math.max(0, t.votes - 1) } : t)),
      );
      return { prev };
    },
    onError: (_err, _tripId, ctx) => {
      if (ctx?.prev) qc.setQueryData(["published-trips"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["published-trips"] }),
  });
}

/** Copies a published trip into the caller's own editable trips. */
export function useAdoptTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tripId: string) => {
      const { data, error } = await sb().rpc("adopt_trip", { trip: tripId });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trips"] }),
  });
}

export function useReportContent() {
  return useMutation({
    mutationFn: async (input: {
      targetType: "trip" | "condition_report" | "profile";
      targetId: string;
      reason: string;
    }) => {
      const { error } = await sb().rpc("report_content", {
        target_type: input.targetType,
        target_id: input.targetId,
        reason: input.reason,
      });
      if (error) throw error;
    },
  });
}

/**
 * Maps report_content's thrown error code to a message worth showing.
 * `own_profile` (reporting yourself) should never actually surface — the UI
 * must never draw a Report control on the caller's own profile in the first
 * place — but it's mapped defensively here rather than left to fall through
 * to the generic string below.
 */
export function reportErrorMessage(code: string): string {
  switch (code) {
    case "own_profile":
      return "You can't report your own profile.";
    case "too_many_reports":
      return "Too many reports — try again later.";
    case "not_found":
      return "That's gone already.";
    default:
      return "Couldn't report. Please try again.";
  }
}

export function useBlockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (targetUserId: string) => {
      const { error } = await sb().rpc("block_user", { target: targetUserId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["published-trips"] }),
  });
}

export interface BlockedAccount {
  blocked_id: string;
  handle: string | null;
  created_at: string;
}

/** The caller's own blocked accounts, so they can be reviewed and undone. */
export function useMyBlocks() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["my-blocks", session?.user.id],
    enabled: !!session,
    queryFn: async (): Promise<BlockedAccount[]> => {
      try {
        const { data, error } = await sb().rpc("my_blocks");
        if (error) throw error;
        return (data ?? []) as BlockedAccount[];
      } catch {
        return []; // hide rather than error (also covers not-yet-deployed RPC)
      }
    },
  });
}

export function useUnblockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (targetUserId: string) => {
      const { error } = await sb().rpc("unblock_user", { target: targetUserId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-blocks"] });
      qc.invalidateQueries({ queryKey: ["published-trips"] });
    },
  });
}

/** The caller's collector rank among all users (see my_rank in the DB). */
export function useMyRank() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["my-rank", session?.user.id],
    enabled: !!session,
    retry: false,
    staleTime: 3600_000,
    queryFn: async (): Promise<{ visited_count: number; top_percent: number } | null> => {
      const { data, error } = await sb().rpc("my_rank");
      if (error) return null; // migration not applied yet -> no badge, no crash
      const row = Array.isArray(data) ? data[0] : data;
      return (row as { visited_count: number; top_percent: number }) ?? null;
    },
  });
}

// ==================================================================== FRIENDS
//
// The backend deliberately exposes no "requests I've sent" surface (see
// my_friend_requests in the migration): a pending request and a declined one
// must read identically to the sender, forever. Nothing here builds a client
// side cache of sent requests either — don't add one.

/** An accepted friend, as listed by my_friends(). */
export interface Friend {
  friend_id: string;
  handle: string | null;
  display_name: string | null;
  home_region: string | null;
  since: string;
}

/** An incoming (not outgoing — there is no such list) friend request. */
export interface FriendRequest {
  requester_id: string;
  handle: string | null;
  display_name: string | null;
  requested_at: string;
}

/** The header of a friend's profile card — exactly what an accepted friend may see. */
export interface FriendProfile {
  id: string;
  handle: string | null;
  display_name: string | null;
  home_region: string | null;
  visited_count: number;
  top_percent: number;
}

/** One place a friend has visited — place identity only, for a dot-field map. */
export interface FriendPlace {
  place_id: string;
  slug: string;
  name: string;
  city: string | null;
  region: string | null;
}

/** A handle lookup hit from find_user_by_handle — deliberately thin (see the RPC doc). */
export interface HandleMatch {
  id: string;
  handle: string;
  display_name: string | null;
}

/** Error codes the friend RPCs can raise, verbatim as `error.message`. */
export type FriendError =
  | "not_signed_in"
  | "not_found"
  | "already_friends"
  | "cannot_friend_self"
  | "blocked"
  | "too_many_requests"
  | "not_owner"
  | "content_suspended";

/**
 * Maps a friend RPC's thrown error code to a message worth showing.
 * `context: "handle"` is for the add-by-handle flow, where `not_found` covers
 * BOTH "no such handle" and "they blocked you" — the two must never be worded
 * differently, or the second one becomes a way to probe for a block. `blocked`
 * only ever means the CALLER blocked the other person (request_friend's own
 * blocked branch), so that one names the Blocked accounts screen.
 */
export function friendErrorMessage(code: string, context: "handle" | "generic" = "generic"): string {
  switch (code as FriendError) {
    case "not_signed_in":
      return "Sign in to do that.";
    case "not_found":
      return context === "handle" ? "No account with that handle." : "That friend isn't available anymore.";
    case "already_friends":
      return "You're already friends.";
    case "cannot_friend_self":
      return "That's your own handle.";
    case "blocked":
      return "You've blocked this account — unblock them from Blocked accounts to add them.";
    case "too_many_requests":
      return "Too many requests — try again later.";
    case "not_owner":
      return "Only the owner can do that.";
    case "content_suspended":
      return "Your account can't do that right now.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** The caller's accepted friends. */
export function useFriends() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["friends", session?.user.id],
    enabled: !!session,
    queryFn: async (): Promise<Friend[]> => {
      try {
        const { data, error } = await sb().rpc("my_friends");
        if (error) throw error;
        return (data ?? []) as Friend[];
      } catch {
        return []; // hide rather than error (also covers not-yet-deployed RPC)
      }
    },
  });
}

/** Incoming friend requests only — there is no outbound list, by design. */
export function useFriendRequests() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["friend-requests", session?.user.id],
    enabled: !!session,
    queryFn: async (): Promise<FriendRequest[]> => {
      try {
        const { data, error } = await sb().rpc("my_friend_requests");
        if (error) throw error;
        return (data ?? []) as FriendRequest[];
      } catch {
        return [];
      }
    },
  });
}

/** A friend's profile header; null if they're gone, blocked, or not actually a friend. */
export function useFriendProfile(friendId: string | undefined) {
  return useQuery({
    queryKey: ["friend-profile", friendId],
    enabled: !!friendId,
    retry: false,
    queryFn: async (): Promise<FriendProfile | null> => {
      try {
        const { data, error } = await sb().rpc("friend_profile", { friend: friendId });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        return (row as FriendProfile) ?? null;
      } catch {
        return null;
      }
    },
  });
}

/** The places a friend has visited — place identity only, for the map. */
export function useFriendPlaces(friendId: string | undefined) {
  return useQuery({
    queryKey: ["friend-places", friendId],
    enabled: !!friendId,
    queryFn: async (): Promise<FriendPlace[]> => {
      try {
        const { data, error } = await sb().rpc("friend_places", { friend: friendId });
        if (error) throw error;
        return (data ?? []) as FriendPlace[];
      } catch {
        return [];
      }
    },
  });
}

/**
 * Looks up an exact handle (case-insensitive, server-side). A mutation rather
 * than a query: it's an on-demand action tied to a rate-limited ledger, not
 * something to cache or refetch. Returns null on a miss (no such handle, or
 * they blocked the caller — indistinguishable on purpose); throws the typed
 * FriendError codes (e.g. too_many_requests) on a real failure.
 */
export function useFindFriendByHandle() {
  return useMutation({
    mutationFn: async (handle: string): Promise<HandleMatch | null> => {
      const { data, error } = await sb().rpc("find_user_by_handle", { target_handle: handle.trim() });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row as HandleMatch) ?? null;
    },
  });
}

/**
 * Sends a friend request; returns 'accepted' when the target had already
 * asked the caller, or 'not_found' for an unknown handle (or a handle that
 * blocked the caller — indistinguishable on purpose, see `friendErrorMessage`'s
 * "handle" context).
 *
 * `request_friend` used to RAISE `not_found` instead of returning it — raising
 * rolled back the rate-limit ledger insert, making unknown-handle probing free
 * and unmetered. The RPC's return type is unchanged (still `text`), so this
 * mutation still throws for every other error code; only `not_found` moved
 * from thrown to returned. Callers must handle both: the caller-side check
 * below covers a returned 'not_found' from the new function, and
 * `friendErrorMessage`'s existing 'not_found' case (used in the `onError`
 * path) keeps working against an old, not-yet-redeployed function that still
 * raises it.
 */
export function useRequestFriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (handle: string): Promise<"pending" | "accepted" | "not_found"> => {
      const { data, error } = await sb().rpc("request_friend", { handle: handle.trim() });
      if (error) throw error;
      return data as "pending" | "accepted" | "not_found";
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friends"] });
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
    },
  });
}

/** Accepts an incoming request; `other` is the requester's id. */
export function useAcceptFriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (other: string) => {
      const { error } = await sb().rpc("accept_friend", { other });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friends"] });
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
    },
  });
}

/** Declines an incoming request; `other` is the requester's id. */
export function useDeclineFriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (other: string) => {
      const { error } = await sb().rpc("decline_friend", { other });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friends"] });
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
    },
  });
}

/** Ends a friendship; idempotent, never errors on the backend. */
export function useRemoveFriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (other: string) => {
      const { error } = await sb().rpc("remove_friend", { other });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friends"] });
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
    },
  });
}

/** Owner-only; adds a friend to a trip exactly as a code-join would. Idempotent. */
export function useInviteFriendToTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { tripId: string; friendId: string }) => {
      const { error } = await sb().rpc("invite_friend_to_trip", { trip: input.tripId, friend: input.friendId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trips"] }),
  });
}

/** Owner-only; adds a friend to a visit time exactly as a code-join would. Idempotent. */
export function useInviteFriendToVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; friendId: string }) => {
      const { error } = await sb().rpc("invite_friend_to_visit", { visit: input.visitId, friend: input.friendId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["visit-times"] }),
  });
}
