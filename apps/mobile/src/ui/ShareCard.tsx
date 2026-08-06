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

export function ShareCard({
  logs,
  handle,
  badge,
}: {
  logs: MyLog[];
  handle: string | null;
  badge?: string | null;
}) {
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {badge ? (
            <View style={styles.badgePill}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          ) : null}
          {handle ? <Text style={styles.handle}>@{handle}</Text> : null}
        </View>
      </View>

      <Svg width={CARD_W} height={MAP_H}>
        {backgroundDots.map((p) => {
          const { x, y } = project(p.lat, p.lng);
          return <Circle key={p.slug} cx={x} cy={y} r={0.7} fill="#5A5A5E" opacity={0.8} />;
        })}
        {visitedDots.map((p) => {
          const { x, y } = project(p.lat, p.lng);
          return (
            <React.Fragment key={p.slug}>
              <Circle cx={x} cy={y} r={5} fill={colors.accentFill} opacity={0.22} />
              <Circle cx={x} cy={y} r={2.4} fill={colors.accentFill} />
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
              <Ionicons name="star" size={11} color={colors.accentFill} />
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
    backgroundColor: "#141414",
    borderRadius: 4,
    padding: spacing.lg,
    alignSelf: "center",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: spacing.sm,
  },
  wordmark: { color: "#FFFFFF", fontSize: 15, fontWeight: "300", letterSpacing: 5 },
  handle: { color: colors.accentFill, fontSize: 13, fontWeight: "600" },
  badgePill: {
    backgroundColor: colors.accentFill,
    borderRadius: 2,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: { color: "#141414", fontSize: 10, fontWeight: "600", letterSpacing: 1 },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#333336",
  },
  statValue: { color: "#FFFFFF", fontSize: 26, fontWeight: "200" },
  statLabel: { color: "#98989D", fontSize: 9, marginTop: 3, letterSpacing: 1.5, textTransform: "uppercase" },
  topRated: { marginTop: spacing.md, gap: 4 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  topName: { color: "#C9C9CD", fontSize: 13, flex: 1 },
  topScore: { color: colors.accentFill, fontSize: 13, fontWeight: "700" },
});
