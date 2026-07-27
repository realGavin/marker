import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import Ionicons from "@expo/vector-icons/Ionicons";
import { skin } from "../skin";
import { pins } from "../lib/pins";
import type { MyLog } from "../lib/data";
import { colors, spacing } from "./theme";

/**
 * The shareable "my map" card. The dot-field background is every place in the
 * directory — the dataset itself draws the country's shape — with the user's
 * visited places lit on top. Pure views: captured to an image by view-shot.
 */

const CARD_W = 340;
const MAP_H = 210;
// Continental bounds; AK/HI places are counted but not plotted.
const B = { west: -125, east: -66.5, south: 24, north: 49.5 };

const project = (lat: number, lng: number) => ({
  x: ((lng - B.west) / (B.east - B.west)) * CARD_W,
  y: ((B.north - lat) / (B.north - B.south)) * MAP_H,
});

const inBounds = (lat: number, lng: number) =>
  lat >= B.south && lat <= B.north && lng >= B.west && lng <= B.east;

const shownRating = (r: number) => (r / 2).toFixed(r % 2 ? 1 : 0);

export function ShareCard({ logs, handle }: { logs: MyLog[]; handle: string | null }) {
  const visited = logs.filter((l) => l.status === "visited");
  const visitedSlugs = useMemo(() => new Set(visited.map((l) => l.place.slug)), [logs]);

  const backgroundDots = useMemo(
    () =>
      pins
        .filter((_, i) => i % 3 === 0)
        .filter((p) => inBounds(p.lat, p.lng) && !visitedSlugs.has(p.slug)),
    [visitedSlugs],
  );
  const visitedDots = useMemo(
    () => pins.filter((p) => visitedSlugs.has(p.slug) && inBounds(p.lat, p.lng)),
    [visitedSlugs],
  );

  const states = new Set(visited.map((l) => l.place.region).filter(Boolean));
  const topRated = [...visited]
    .filter((l) => l.rating != null)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 3);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.wordmark}>{skin.vocab.appName.toUpperCase()}</Text>
        {handle ? <Text style={styles.handle}>@{handle}</Text> : null}
      </View>

      <Svg width={CARD_W} height={MAP_H}>
        {backgroundDots.map((p) => {
          const { x, y } = project(p.lat, p.lng);
          return <Circle key={p.slug} cx={x} cy={y} r={0.7} fill="#3E6B58" opacity={0.55} />;
        })}
        {visitedDots.map((p) => {
          const { x, y } = project(p.lat, p.lng);
          return (
            <React.Fragment key={p.slug}>
              <Circle cx={x} cy={y} r={5} fill={colors.accent} opacity={0.25} />
              <Circle cx={x} cy={y} r={2.4} fill={colors.accent} />
            </React.Fragment>
          );
        })}
      </Svg>

      <View style={styles.statsRow}>
        <Stat value={visited.length} label={skin.vocab.visited.toLowerCase()} />
        <Stat value={states.size} label={states.size === 1 ? "state" : "states"} />
        <Stat
          value={logs.filter((l) => l.status === "want").length}
          label={skin.vocab.wantTo.toLowerCase()}
        />
      </View>

      {topRated.length > 0 && (
        <View style={styles.topRated}>
          {topRated.map((l) => (
            <View key={l.place_id} style={styles.topRow}>
              <Ionicons name="star" size={11} color={colors.accent} />
              <Text style={styles.topName} numberOfLines={1}>
                {l.place.name}
              </Text>
              <Text style={styles.topScore}>{shownRating(l.rating!)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: CARD_W + spacing.lg * 2,
    backgroundColor: colors.primaryDark,
    borderRadius: 20,
    padding: spacing.lg,
    alignSelf: "center",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: spacing.sm,
  },
  wordmark: { color: "#FFFFFF", fontSize: 15, fontWeight: "800", letterSpacing: 3 },
  handle: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#3E6B58",
  },
  statValue: { color: "#FFFFFF", fontSize: 26, fontWeight: "800" },
  statLabel: { color: "#9DB8AC", fontSize: 12, marginTop: 2 },
  topRated: { marginTop: spacing.md, gap: 4 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  topName: { color: "#DCE8E1", fontSize: 13, flex: 1 },
  topScore: { color: colors.accent, fontSize: 13, fontWeight: "700" },
});
