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

/** A scheduled upcoming visit; the skin names these (see vocab.visitTime). */
export interface VisitTime {
  id: string;
  at: string;
  place: { id: string; name: string; slug: string };
}

export function useVisitTimes() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["visit-times", session?.user.id],
    enabled: !!session,
    queryFn: async (): Promise<VisitTime[]> => {
      const { data, error } = await sb()
        .from("visit_times")
        .select("id, at, place:places(id, name, slug)")
        .order("at", { ascending: true });
      if (error) throw error;
      return (data as unknown as VisitTime[]) ?? [];
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

export interface ConditionSummary {
  place_id: string;
  kind: string;
  reporters: number;
  latest_note: string | null;
  latest_at: string;
  expires_at: string;
  /** id of the report latest_note/latest_at came from; the endorse target. */
  latest_report_id: string;
}

/** Active, corroborated condition reports for a place (>=2 reporters, unexpired). */
export function useConditions(placeId: string | undefined) {
  return useQuery({
    queryKey: ["conditions", placeId],
    enabled: !!placeId,
    queryFn: async (): Promise<ConditionSummary[]> => {
      try {
        const { data, error } = await sb()
          .from("condition_summary")
          .select("place_id,kind,reporters,latest_note,latest_at,expires_at,latest_report_id")
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
    mutationFn: async (input: { placeId: string; kind: string; note?: string | null }) => {
      const { data, error } = await sb().rpc("report_condition", {
        place: input.placeId,
        kind: input.kind,
        note: input.note ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ["conditions", v.placeId] }),
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
  itinerary: TripItinerary;
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
          .select("id,title,summary,author_handle,author_id,days,stops,votes,editor_pick,published_at,itinerary")
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
    mutationFn: async (input: { targetType: "trip" | "condition_report"; targetId: string; reason: string }) => {
      const { error } = await sb().rpc("report_content", {
        target_type: input.targetType,
        target_id: input.targetId,
        reason: input.reason,
      });
      if (error) throw error;
    },
  });
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
