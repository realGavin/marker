import React, { useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  type CameraRef,
  type GeoJSONSourceRef,
} from "@maplibre/maplibre-react-native";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";
import { buildMapStyle } from "../../lib/map-style";
import { pins, pinsGeoJSON, searchPins, toGeoJSON, type Pin } from "../../lib/pins";
import { useMyLogs, useProfile, useUpsertLog, useDeleteLog, usePlace } from "../../lib/data";
import { PlacePhoto } from "../../ui/PlacePhoto";

const US_CENTER: [number, number] = [-98.5, 39.8];

/** Centroid of the user's home state, from the bundled pin data. */
function regionCenter(region: string | null | undefined): { center: [number, number]; zoom: number } {
  if (!region) return { center: US_CENTER, zoom: 3.2 };
  const rows = pins.filter((p) => p.region === region);
  if (rows.length === 0) return { center: US_CENTER, zoom: 3.2 };
  const lat = rows.reduce((s, p) => s + p.lat, 0) / rows.length;
  const lng = rows.reduce((s, p) => s + p.lng, 0) / rows.length;
  return { center: [lng, lat], zoom: 6 };
}

export default function MapScreen() {
  const router = useRouter();
  const camera = useRef<CameraRef>(null);
  const source = useRef<GeoJSONSourceRef>(null);
  const [query, setQuery] = useState("");
  const [locBusy, setLocBusy] = useState(false);
  const [preview, setPreview] = useState<Pin | null>(null);
  const { data: profile } = useProfile();
  const home = useMemo(() => regionCenter(profile?.home_region), [profile?.home_region]);
  const mapStyle = useMemo(buildMapStyle, []);
  const results = useMemo(() => searchPins(query), [query]);
  const { data: logs } = useMyLogs();
  // multi-select filters: OR within a group, AND across groups
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // one dropdown per filter group; only one open at a time
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // distance ring is radio-style: one radius at a time, anchored on the user
  const [radiusMi, setRadiusMi] = useState<number | null>(null);
  const [userLoc, setUserLoc] = useState<[number, number] | null>(null);

  const pickRadius = async (mi: number) => {
    if (radiusMi === mi) {
      setRadiusMi(null);
      return;
    }
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return;
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    setUserLoc([loc.coords.latitude, loc.coords.longitude]);
    setRadiusMi(mi);
    camera.current?.flyTo({ center: [loc.coords.longitude, loc.coords.latitude], zoom: mi >= 100 ? 7 : mi >= 50 ? 8 : 9, duration: 800 });
  };

  const toggleFilter = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const filteredGeoJSON = useMemo(() => {
    if (selected.size === 0 && !(radiusMi && userLoc)) return pinsGeoJSON;
    const statusSel = ["visited", "want"].filter((k) => selected.has(k));
    const statusSlugs = new Set(
      (logs ?? []).filter((l) => statusSel.includes(l.status)).map((l) => l.place.slug),
    );
    const tagGroups = new Map<string, string[]>();
    for (const f of skin.pinFilters) {
      if (!selected.has(f.key)) continue;
      tagGroups.set(f.group, [...(tagGroups.get(f.group) ?? []), f.key]);
    }
    // flat-earth distance is fine at these radii
    const maxDegSq = radiusMi ? (radiusMi * 1609.34 / 111_320) ** 2 : null;
    const cosLat = userLoc ? Math.cos((userLoc[0] * Math.PI) / 180) : 1;
    return toGeoJSON(
      pins.filter((p) => {
        if (statusSel.length > 0 && !statusSlugs.has(p.slug)) return false;
        for (const keys of tagGroups.values()) {
          if (!keys.some((k) => p.tags.includes(k))) return false;
        }
        if (maxDegSq && userLoc) {
          const d2 = (p.lat - userLoc[0]) ** 2 + ((p.lng - userLoc[1]) * cosLat) ** 2;
          if (d2 > maxDegSq) return false;
        }
        return true;
      }),
    );
  }, [selected, logs, radiusMi, userLoc]);

  const activeCount = selected.size + (radiusMi ? 1 : 0);

  // "Your log" is an engine-level group; skin groups follow; Distance renders
  // separately (radio semantics + location fetch)
  const filterGroups: Array<{ key: string; label: string; options: Array<{ key: string; label: string }> }> = [
    {
      key: "status",
      label: "Your log",
      options: [
        { key: "visited", label: skin.vocab.visited },
        { key: "want", label: skin.vocab.wantTo },
      ],
    },
    ...skin.pinFilterGroups.map((g) => ({
      key: g.key,
      label: g.label,
      options: skin.pinFilters.filter((f) => f.group === g.key),
    })),
  ];

  const groupCount = (g: (typeof filterGroups)[number]) =>
    g.options.filter((o) => selected.has(o.key)).length;
  const openedGroup = filterGroups.find((g) => g.key === openGroup);

  // color pins by the user's log status
  const pinColor = useMemo(() => {
    const visited = (logs ?? []).filter((l) => l.status === "visited").map((l) => l.place.slug);
    const want = (logs ?? []).filter((l) => l.status === "want").map((l) => l.place.slug);
    if (!visited.length && !want.length) return colors.defaultPin as unknown;
    return [
      "case",
      ["in", ["get", "slug"], ["literal", visited]], colors.visitedPin,
      ["in", ["get", "slug"], ["literal", want]], colors.wantPin,
      colors.defaultPin,
    ] as unknown;
  }, [logs]);

  const flyTo = (lng: number, lat: number, zoom = 13) =>
    camera.current?.flyTo({ center: [lng, lat], zoom, duration: 800 });

  const pickResult = (p: Pin) => {
    setQuery("");
    flyTo(p.lng, p.lat);
  };

  const nearMe = async () => {
    setLocBusy(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      flyTo(loc.coords.longitude, loc.coords.latitude, 10);
    } finally {
      setLocBusy(false);
    }
  };

  const onPinPress = async (e: { nativeEvent: { features: GeoJSON.Feature[] } }) => {
    const f = e.nativeEvent.features[0];
    if (!f) return;
    const props = f.properties as { slug?: string; cluster?: boolean; cluster_id?: number };
    if (props.cluster && props.cluster_id != null) {
      const zoom = await source.current?.getClusterExpansionZoom(props.cluster_id).catch(() => null);
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      camera.current?.flyTo({ center: [lng!, lat!], zoom: (zoom ?? 8) + 0.5, duration: 500 });
    } else if (props.slug) {
      const pin = pins.find((p) => p.slug === props.slug);
      if (pin) setPreview(pin);
    }
  };

  return (
    <View style={styles.container}>
      <MapLibreMap style={StyleSheet.absoluteFill} mapStyle={mapStyle}>
        <Camera ref={camera} initialViewState={{ center: home.center, zoom: home.zoom }} />
        <GeoJSONSource
          ref={source}
          id="places"
          data={filteredGeoJSON}
          cluster
          clusterRadius={45}
          clusterMaxZoom={13}
          onPress={onPinPress}
          hitbox={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Layer
            type="circle"
            id="clusters"
            filter={["has", "point_count"]}
            paint={{
              "circle-color": colors.primary,
              "circle-opacity": 0.85,
              "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 14, 100, 22, 800, 30],
            }}
          />
          <Layer
            type="symbol"
            id="cluster-count"
            filter={["has", "point_count"]}
            layout={{
              "text-field": ["get", "point_count_abbreviated"],
              "text-size": 13,
              "text-font": ["Noto Sans Medium"],
            }}
            paint={{ "text-color": "#FFFFFF" }}
          />
          <Layer
            type="circle"
            id="pin"
            filter={["!", ["has", "point_count"]]}
            paint={{
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              "circle-color": pinColor as any,
              "circle-radius": 6,
              "circle-stroke-width": 2,
              "circle-stroke-color": "#FFFFFF",
            }}
          />
        </GeoJSONSource>
      </MapLibreMap>

      <View style={styles.searchWrap}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.textSecondary} />
          <TextInput
            style={styles.searchInput}
            placeholder={`Search ${skin.vocab.places}…`}
            placeholderTextColor={colors.textSecondary}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery("")}>
              <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>
        {query.length === 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: spacing.xs }}
            contentContainerStyle={{ gap: spacing.xs }}
          >
            {filterGroups.map((g) => {
              const n = groupCount(g);
              const active = openGroup === g.key || n > 0;
              return (
                <Pressable
                  key={g.key}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setOpenGroup(openGroup === g.key ? null : g.key)}
                >
                  <Text style={[styles.chipText, active && { color: "#FFF" }]}>
                    {g.label}{n > 0 ? ` (${n})` : ""}
                  </Text>
                  <Ionicons
                    name={openGroup === g.key ? "chevron-up" : "chevron-down"}
                    size={12}
                    color={active ? "#FFF" : colors.textSecondary}
                  />
                </Pressable>
              );
            })}
            <Pressable
              style={[styles.chip, (openGroup === "distance" || radiusMi != null) && styles.chipActive]}
              onPress={() => setOpenGroup(openGroup === "distance" ? null : "distance")}
            >
              <Text
                style={[
                  styles.chipText,
                  (openGroup === "distance" || radiusMi != null) && { color: "#FFF" },
                ]}
              >
                {radiusMi ? `Within ${radiusMi} mi` : "Distance"}
              </Text>
              <Ionicons
                name={openGroup === "distance" ? "chevron-up" : "chevron-down"}
                size={12}
                color={openGroup === "distance" || radiusMi != null ? "#FFF" : colors.textSecondary}
              />
            </Pressable>
            {activeCount > 0 && (
              <Pressable
                style={styles.chip}
                onPress={() => {
                  setSelected(new Set());
                  setRadiusMi(null);
                  setOpenGroup(null);
                }}
              >
                <Text style={styles.chipText}>Clear</Text>
              </Pressable>
            )}
          </ScrollView>
        )}
        {openedGroup && query.length === 0 && (
          <View style={styles.filterMenu}>
            {openedGroup.options.map((o) => {
              const on = selected.has(o.key);
              return (
                <Pressable key={o.key} style={styles.filterRow} onPress={() => toggleFilter(o.key)}>
                  <Ionicons
                    name={on ? "checkbox" : "square-outline"}
                    size={20}
                    color={on ? colors.primary : colors.textSecondary}
                  />
                  <Text style={type.body}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {openGroup === "distance" && query.length === 0 && (
          <View style={styles.filterMenu}>
            {[25, 50, 100].map((mi) => {
              const on = radiusMi === mi;
              return (
                <Pressable key={mi} style={styles.filterRow} onPress={() => pickRadius(mi)}>
                  <Ionicons
                    name={on ? "radio-button-on" : "radio-button-off"}
                    size={20}
                    color={on ? colors.primary : colors.textSecondary}
                  />
                  <Text style={type.body}>Within {mi} miles</Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {results.length > 0 && (
          <FlatList
            style={styles.results}
            keyboardShouldPersistTaps="handled"
            data={results}
            keyExtractor={(p) => p.slug}
            renderItem={({ item }) => (
              <Pressable style={styles.resultRow} onPress={() => pickResult(item)}>
                <Text style={type.body} numberOfLines={1}>{item.name}</Text>
                <Text style={type.caption}>{[item.city, item.region].filter(Boolean).join(", ")}</Text>
              </Pressable>
            )}
          />
        )}
      </View>

      <Pressable style={styles.nearMe} onPress={nearMe} disabled={locBusy}>
        <Ionicons name={locBusy ? "hourglass" : "locate"} size={22} color={colors.primary} />
      </Pressable>

      {preview && <PreviewCard pin={preview} onClose={() => setPreview(null)} />}
    </View>
  );
}

/** Bottom sheet shown on pin tap: glance, quick-log, or open the full page. */
function PreviewCard({ pin, onClose }: { pin: Pin; onClose: () => void }) {
  const router = useRouter();
  const { data: logs } = useMyLogs();
  const { data: place } = usePlace(pin.slug);
  const upsert = useUpsertLog();
  const remove = useDeleteLog();
  const myLog = logs?.find((l) => l.place.slug === pin.slug);
  const busy = !place || upsert.isPending || remove.isPending;

  // bookmark toggle: want -> clear, otherwise mark want (overwrites nothing rated)
  const toggleWant = () => {
    if (!place) return;
    if (myLog?.status === "want") remove.mutate(place.id);
    else upsert.mutate({ placeId: place.id, status: "want" });
  };

  return (
    <View style={styles.preview}>
      <PlacePhoto slug={pin.slug} height={120} style={{ marginBottom: spacing.sm }} />
      <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <View style={{ flex: 1 }}>
          <Text style={type.heading} numberOfLines={1}>{pin.name}</Text>
          <Text style={type.caption}>
            {[place?.city, pin.region].filter(Boolean).join(", ")}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10}>
          <Ionicons name="close" size={20} color={colors.textSecondary} />
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
        <Pressable
          style={[styles.previewButton, myLog?.status === "visited" && styles.previewButtonActive]}
          disabled={busy}
          onPress={() => place && upsert.mutate({ placeId: place.id, status: "visited" })}
        >
          <Ionicons
            name={myLog?.status === "visited" ? "checkmark-circle" : "checkmark-circle-outline"}
            size={17}
            color={myLog?.status === "visited" ? "#FFF" : colors.primary}
          />
          <Text style={[styles.previewButtonText, myLog?.status === "visited" && { color: "#FFF" }]}>
            {skin.vocab.visited}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.previewWant, myLog?.status === "want" && styles.previewWantActive]}
          disabled={busy}
          onPress={toggleWant}
          hitSlop={4}
        >
          <Ionicons
            name={myLog?.status === "want" ? "bookmark" : "bookmark-outline"}
            size={18}
            color={myLog?.status === "want" ? "#FFF" : colors.accent}
          />
        </Pressable>
        <Pressable
          style={styles.previewButton}
          onPress={() => {
            onClose();
            router.push(`/place/${pin.slug}`);
          }}
        >
          <Text style={styles.previewButtonText}>View</Text>
          <Ionicons name="arrow-forward" size={15} color={colors.primary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  searchWrap: { position: "absolute", top: spacing.md, left: spacing.md, right: spacing.md },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    height: 44,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  searchInput: { flex: 1, fontSize: 16, color: colors.textPrimary },
  chip: {
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: spacing.md,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  filterMenu: {
    marginTop: spacing.xs,
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  filterHeader: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: spacing.sm,
    marginBottom: 2,
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 7,
  },
  results: {
    marginTop: spacing.xs,
    backgroundColor: colors.surface,
    borderRadius: 10,
    maxHeight: 280,
  },
  resultRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#EEE9DD",
  },
  preview: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: spacing.md,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  previewButton: {
    flex: 1,
    flexDirection: "row",
    gap: 6,
    height: 42,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  previewButtonActive: { backgroundColor: colors.primary },
  previewButtonText: { fontSize: 14, fontWeight: "700", color: colors.primary },
  previewWant: {
    width: 46,
    height: 42,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  previewWantActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  nearMe: {
    position: "absolute",
    right: spacing.md,
    bottom: spacing.lg + 110,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
});
