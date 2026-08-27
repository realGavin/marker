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
import { scoreColor } from "../../ui/ConditionScore";
import { buildMapStyle } from "../../lib/map-style";
import { formatRating, pins, pinsGeoJSON, searchAll, toGeoJSON, type Pin, type SearchResult } from "../../lib/pins";
import {
  useMyLogs,
  useProfile,
  useUpsertLog,
  useDeleteLog,
  usePlace,
  useRatedPlaces,
  useFlaggedPlaces,
  type FlaggedPlace,
} from "../../lib/data";
import { PlacePhoto } from "../../ui/PlacePhoto";

const US_CENTER: [number, number] = [-98.5, 39.8];

/** Rating stored as 0–20 (half steps); shown as 0–10. Matches log.tsx / place page. */
const shownRating = formatRating;

/** Always render condition labels from the skin — the engine never names one. */
const conditionLabel = (kind: string): string =>
  skin.conditionKinds.find((k) => k.key === kind)?.label ?? kind;

/** Compact star + numeral, matching the readout used in log.tsx rows. */
function RatingReadout({ avg }: { avg: number }) {
  return (
    <View style={styles.rating}>
      <Ionicons name="star" size={13} color={colors.accent} />
      <Text style={[type.caption, { color: colors.textPrimary }]}>{shownRating(avg)}</Text>
    </View>
  );
}

/**
 * Small warning glyph for a place carrying an active Poor condition verdict —
 * sourced entirely from useFlaggedPlaces(), so it costs nothing beyond the
 * one app-wide flagged-places fetch. Renders nothing for the overwhelming
 * majority of places, which have no flag at all.
 */
function FlaggedIndicator({ flag }: { flag: FlaggedPlace }) {
  return (
    <View style={styles.conditionIndicator}>
      <Ionicons name="warning" size={13} color={scoreColor(flag.worstScore)} />
      <Text style={[type.caption, { color: scoreColor(flag.worstScore) }]} numberOfLines={1}>
        {conditionLabel(flag.worstKind)} · {flag.reporters}
      </Text>
    </View>
  );
}

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
  const results = useMemo(() => searchAll(query, { tags: skin.pinFilters }), [query]);
  const { data: logs } = useMyLogs();
  // One flat-cost fetch of every rated place (see useRatedPlaces) — never
  // per-viewport, never per-search-keystroke. Slug-keyed, so search rows,
  // the map pins, and the preview card all read off this single cached
  // source of truth instead of each re-resolving slugs -> ids and
  // re-fetching place_rating_stats themselves. Refreshes roughly hourly.
  const { data: ratedPlaces } = useRatedPlaces();
  const ratingBySlug = useMemo(() => {
    if (!ratedPlaces) return undefined;
    const entries = Object.entries(ratedPlaces);
    if (entries.length === 0) return undefined;
    const m = new Map<string, number>();
    for (const [slug, r] of entries) m.set(slug, r.avg);
    return m;
  }, [ratedPlaces]);
  // Same single flat-cost, slug-keyed fetch pattern as useRatedPlaces —
  // shared by the search results list and the pin preview card below so
  // neither has to resolve a place id first.
  const { data: flaggedPlaces } = useFlaggedPlaces();
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

  // Rating-merged, unfiltered baseline. Rebuilds only when ratingBySlug
  // itself changes (roughly hourly, or once on first load) — not on every
  // render. Pre-launch, almost nothing clears the rating floor, so
  // ratingBySlug is usually undefined and this collapses to the static,
  // zero-cost pinsGeoJSON built once at import time.
  const ratedPinsGeoJSON = useMemo(
    () => (ratingBySlug ? toGeoJSON(pins, ratingBySlug) : pinsGeoJSON),
    [ratingBySlug],
  );

  const filteredGeoJSON = useMemo(() => {
    // No filters active: return the same (referentially stable) object each
    // render so the GeoJSONSource `data` prop doesn't change and MapLibre
    // never re-pushes/re-indexes — this branch does NOT rebuild the 12.6k
    // features on every unrelated re-render (e.g. `logs` refetching).
    if (selected.size === 0 && !(radiusMi && userLoc)) return ratedPinsGeoJSON;
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
      ratingBySlug,
    );
  }, [selected, logs, radiusMi, userLoc, ratingBySlug, ratedPinsGeoJSON]);

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

  const pickResult = (r: SearchResult) => {
    if (r.kind === "place") {
      setQuery("");
      flyTo(r.pin.lng, r.pin.lat);
    } else if (r.kind === "city") {
      setQuery("");
      flyTo(r.lng, r.lat, 10);
    } else if (r.kind === "region") {
      setQuery("");
      flyTo(r.lng, r.lat, 6);
    } else {
      setSelected((prev) => new Set(prev).add(r.key));
      setQuery("");
    }
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
          {/*
            Three stacked circle layers read as a marker rather than a flat
            dot, with no bundled image asset: a soft drop shadow underneath
            (offset down, so the pin reads as sitting above the map), a
            larger core circle with a thick light ring for contrast against
            aerial/terrain, and a small light center dot on top (the
            "bullseye" look common to pin glyphs). The log-status color
            semantics stay entirely on the core layer's circle-color
            (via pinColor), unchanged.
          */}
          <Layer
            type="circle"
            id="pin-shadow"
            filter={["!", ["has", "point_count"]]}
            paint={{
              "circle-color": colors.primary,
              "circle-opacity": 0.16,
              "circle-blur": 0.4,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 16, 11],
              "circle-translate": [0, 2],
            }}
          />
          <Layer
            type="circle"
            id="pin"
            filter={["!", ["has", "point_count"]]}
            paint={{
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              "circle-color": pinColor as any,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 16, 10],
              "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 16, 2.5],
              "circle-stroke-color": colors.surface,
            }}
          />
          <Layer
            type="circle"
            id="pin-core"
            filter={["!", ["has", "point_count"]]}
            paint={{
              "circle-color": colors.surface,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 1.6, 16, 2.6],
            }}
          />
          {/*
            Names (+ rating, for the small set of places that clear the
            >=3-rating floor — see useRatedPlaces) beside the pin. Same
            cluster filter as the pin layers, so a label can only ever
            render on an actual unclustered leaf feature — never on a
            cluster bubble. minzoom 11 keeps them off the dense low-zoom
            view where clusterRadius (45px) still folds most points
            together and per-name labels would just be noise;
            textAllowOverlap:false lets MapLibre cull collisions natively
            as more points de-cluster on the way in to clusterMaxZoom (13).
          */}
          <Layer
            type="symbol"
            id="pin-label"
            filter={["!", ["has", "point_count"]]}
            minzoom={11}
            layout={{
              "text-field": ["get", "label"],
              "text-font": ["Noto Sans Medium"],
              "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 16, 13],
              "text-anchor": "left",
              "text-offset": [0.9, 0],
              "text-max-width": 10,
              "text-allow-overlap": false,
              "text-optional": true,
            }}
            paint={{
              "text-color": colors.textPrimary,
              "text-halo-color": colors.surface,
              "text-halo-width": 1.4,
              "text-halo-blur": 0.2,
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
            keyExtractor={(r) =>
              r.kind === "place"
                ? `place-${r.pin.slug}`
                : r.kind === "city"
                  ? `city-${r.city}-${r.region}`
                  : r.kind === "region"
                    ? `region-${r.region}`
                    : `tag-${r.key}`
            }
            renderItem={({ item }) => {
              if (item.kind === "place") {
                // Both merged in purely by slug — see useRatedPlaces /
                // useFlaggedPlaces — so this row never has to resolve a
                // place id just to show a rating or a condition warning.
                const avg = ratingBySlug?.get(item.pin.slug);
                const flag = flaggedPlaces?.[item.pin.slug];
                return (
                  <Pressable style={[styles.resultRow, styles.resultRowBetween]} onPress={() => pickResult(item)}>
                    <View style={{ flex: 1 }}>
                      <Text style={type.body} numberOfLines={1}>{item.pin.name}</Text>
                      <Text style={type.caption}>{[item.pin.city, item.pin.region].filter(Boolean).join(", ")}</Text>
                    </View>
                    {(avg !== undefined || flag) && (
                      <View style={{ alignItems: "flex-end", gap: 2 }}>
                        {avg !== undefined && <RatingReadout avg={avg} />}
                        {flag && <FlaggedIndicator flag={flag} />}
                      </View>
                    )}
                  </Pressable>
                );
              }
              if (item.kind === "city") {
                return (
                  <Pressable style={[styles.resultRow, styles.resultRowBetween]} onPress={() => pickResult(item)}>
                    <View style={styles.resultRowLeft}>
                      <Ionicons name="location-outline" size={16} color={colors.textSecondary} />
                      <Text style={type.body} numberOfLines={1}>{item.city}, {item.region}</Text>
                    </View>
                  </Pressable>
                );
              }
              if (item.kind === "region") {
                return (
                  <Pressable style={[styles.resultRow, styles.resultRowBetween]} onPress={() => pickResult(item)}>
                    <View style={styles.resultRowLeft}>
                      <Ionicons name="flag-outline" size={16} color={colors.textSecondary} />
                      <Text style={type.body} numberOfLines={1}>{item.regionName}</Text>
                    </View>
                  </Pressable>
                );
              }
              return (
                <Pressable style={[styles.resultRow, styles.resultRowBetween]} onPress={() => pickResult(item)}>
                  <View style={styles.resultRowLeft}>
                    <Ionicons name="funnel-outline" size={16} color={colors.textSecondary} />
                    <Text style={type.body} numberOfLines={1}>{item.label}</Text>
                  </View>
                  <Text style={type.caption}>{item.count} {skin.vocab.places}</Text>
                </Pressable>
              );
            }}
          />
        )}
      </View>

      <Pressable style={styles.nearMe} onPress={nearMe} disabled={locBusy}>
        <Ionicons name={locBusy ? "hourglass" : "locate"} size={22} color={colors.primary} />
      </Pressable>

      {preview && (
        <PreviewCard
          pin={preview}
          ratingBySlug={ratingBySlug}
          flaggedBySlug={flaggedPlaces}
          onClose={() => setPreview(null)}
        />
      )}
    </View>
  );
}

/** Bottom sheet shown on pin tap: glance, quick-log, or open the full page. */
function PreviewCard({
  pin,
  ratingBySlug,
  flaggedBySlug,
  onClose,
}: {
  pin: Pin;
  ratingBySlug: Map<string, number> | undefined;
  flaggedBySlug: Record<string, FlaggedPlace> | undefined;
  onClose: () => void;
}) {
  const router = useRouter();
  const { data: logs } = useMyLogs();
  const { data: place } = usePlace(pin.slug);
  // Slug-keyed off the same app-wide useRatedPlaces() fetch the map screen
  // already made, rather than a per-place round trip (see H2 in the review
  // that removed usePlaceRating from this screen).
  const rating = ratingBySlug?.get(pin.slug);
  const flag = flaggedBySlug?.[pin.slug];
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
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 2 }}>
            <Text style={type.caption}>
              {[place?.city, pin.region].filter(Boolean).join(", ")}
            </Text>
            {rating !== undefined && <RatingReadout avg={rating} />}
            {flag && <FlaggedIndicator flag={flag} />}
          </View>
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
    borderRadius: 3,
    paddingHorizontal: spacing.md,
    height: 44,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  searchInput: { flex: 1, fontSize: 16, color: colors.textPrimary },
  chip: {
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: spacing.md,
    height: 32,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  filterMenu: {
    marginTop: spacing.xs,
    backgroundColor: colors.surface,
    borderRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.hairline,
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
    borderRadius: 3,
    maxHeight: 280,
  },
  resultRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E7E7E3",
  },
  resultRowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  resultRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexShrink: 1,
  },
  rating: { flexDirection: "row", alignItems: "center", gap: 4 },
  conditionIndicator: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 140 },
  preview: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: 4,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  previewButton: {
    flex: 1,
    flexDirection: "row",
    gap: 6,
    height: 42,
    borderRadius: 3,
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
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  previewWantActive: { backgroundColor: colors.accentFill, borderColor: colors.accent },
  nearMe: {
    position: "absolute",
    right: spacing.md,
    bottom: spacing.lg + 110,
    width: 48,
    height: 48,
    borderRadius: 4,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.hairline,
  },
});
