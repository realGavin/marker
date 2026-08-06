import React, { useState } from "react";
import { Image, type StyleProp, type ImageStyle } from "react-native";
import { photoUrl } from "../lib/env";

/**
 * Aerial photo of a place, served flat-cost from our own bucket.
 * Renders nothing when photos aren't configured or this one is missing,
 * so screens degrade gracefully instead of showing a broken frame.
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
      resizeMode="cover"
      style={[{ width: "100%", height, borderRadius: 4, backgroundColor: "#E4E9E2" }, style]}
    />
  );
}
