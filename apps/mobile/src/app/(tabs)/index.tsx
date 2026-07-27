import React, { useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
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
import { pins, pinsGeoJSON, searchPins, type Pin } from "../../lib/pins";
import { useMyLogs, useProfile, useUpsertLog, usePlace } from "../../lib/data";

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
          data={pinsGeoJSON}
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
        {results.length > 0 && (
          <FlatList
            style={styles.results}
            keyboardShouldPersistTaps="handled"
            data={results}
            keyExtractor={(p) => p.slug}
            renderItem={({ item }) => (
              <Pressable style={styles.resultRow} onPress={() => pickResult(item)}>
                <Text style={type.body} numberOfLines={1}>{item.name}</Text>
                <Text style={type.caption}>{item.region}</Text>
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
  const myLog = logs?.find((l) => l.place.slug === pin.slug);

  return (
    <View style={styles.preview}>
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
          disabled={!place || upsert.isPending}
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
