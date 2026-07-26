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
import { pinsGeoJSON, searchPins, type Pin } from "../../lib/pins";

const US_CENTER: [number, number] = [-98.5, 39.8];

export default function MapScreen() {
  const router = useRouter();
  const camera = useRef<CameraRef>(null);
  const source = useRef<GeoJSONSourceRef>(null);
  const [query, setQuery] = useState("");
  const [locBusy, setLocBusy] = useState(false);
  const mapStyle = useMemo(buildMapStyle, []);
  const results = useMemo(() => searchPins(query), [query]);

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
      router.push(`/place/${props.slug}`);
    }
  };

  return (
    <View style={styles.container}>
      <MapLibreMap style={StyleSheet.absoluteFill} mapStyle={mapStyle}>
        <Camera ref={camera} initialViewState={{ center: US_CENTER, zoom: 3.2 }} />
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
              "circle-color": colors.defaultPin,
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
  nearMe: {
    position: "absolute",
    right: spacing.md,
    bottom: spacing.lg,
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
