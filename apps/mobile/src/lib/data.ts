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
  request: { region: string; days: number; rounds: number };
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
        .select("id,request,itinerary,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TripPlan[];
    },
  });
}

/** Error codes surfaced by the plan-trip function for UI branching. */
export type PlanTripError = "upgrade_required" | "monthly_limit" | "region_not_found" | "no_places_in_region" | "failed";

export function usePlanTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { region: string; days: number; rounds: number; budget: string; notes?: string }) => {
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
