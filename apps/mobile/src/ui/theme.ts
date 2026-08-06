import type { TextStyle } from "react-native";
import { skin } from "../skin";

/** Engine-wide theme, sourced from the active skin. */
export const colors = skin.theme.colors;
export const radii = skin.theme.radii;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

const t = skin.theme.typography;
const caps = (on: boolean): TextStyle => (on ? { textTransform: "uppercase" } : {});

export const type = {
  /** Screen and place titles. */
  title: {
    fontSize: t.display.fontSize,
    fontWeight: t.display.fontWeight,
    letterSpacing: t.display.letterSpacing,
    color: colors.textPrimary,
    ...caps(t.display.uppercase),
  } satisfies TextStyle,
  /** Section headings. */
  heading: {
    fontSize: t.heading.fontSize,
    fontWeight: t.heading.fontWeight,
    letterSpacing: t.heading.letterSpacing,
    color: colors.textPrimary,
    ...caps(t.heading.uppercase),
  } satisfies TextStyle,
  body: { fontSize: 15, color: colors.textPrimary } satisfies TextStyle,
  caption: { fontSize: 12, color: colors.textSecondary, letterSpacing: 0.2 } satisfies TextStyle,
  /** Tiny caps label, pairs under numerals and on chips. */
  label: {
    fontSize: t.label.fontSize,
    letterSpacing: t.label.letterSpacing,
    color: colors.textSecondary,
    textTransform: "uppercase",
  } satisfies TextStyle,
  /** Instrument-cluster numerals. */
  numeral: {
    fontSize: t.numeral.fontSize,
    fontWeight: t.numeral.fontWeight,
    color: colors.textPrimary,
  } satisfies TextStyle,
};

/** Hairline-bordered surface — this design language uses borders, not shadows. */
export const hairlineCard = {
  backgroundColor: colors.surface,
  borderWidth: 1,
  borderColor: colors.hairline,
  borderRadius: radii.card,
} as const;
