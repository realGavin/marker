import React, { useState } from "react";
import { Image, type ImageStyle } from "expo-image";
import type { StyleProp } from "react-native";
import { photoUrl } from "../lib/env";

/**
 * Aerial photo of a place, served flat-cost from our own bucket.
 * Renders nothing when photos aren't configured or this one is missing,
 * so screens degrade gracefully instead of showing a broken frame.
 *
 * Uses expo-image for a dedicated disk cache (RN's Image shares the small
 * NSURLCache with every REST response, so aerials get evicted and re-downloaded
 * on revisit) plus a soft fade instead of a hard pop from the placeholder.
 */
export function PlacePhoto({
  slug,
  height = 180,
  style,
}: {
  slug: string;
  height?: number;
  style?: StyleProp<ImageStyle>;
}) {
  const [failed, setFailed] = useState(false);
  const url = photoUrl(slug);
  if (!url || failed) return null;
  return (
    <Image
      source={{ uri: url }}
      onError={() => setFailed(true)}
      contentFit="cover"
      cachePolicy="memory-disk"
      transition={200}
      style={[{ width: "100%", height, borderRadius: 4, backgroundColor: "#E4E9E2" }, style]}
    />
  );
}
