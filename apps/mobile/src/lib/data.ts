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

export function useCreateList() {
  const qc = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (title: string) => {
      if (!session) throw new Error("not signed in");
      const { error } = await sb().from("lists").insert({ owner_id: session.user.id, title, niche_id: skin.nicheId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lists"] }),
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
