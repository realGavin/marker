import { skin } from "../skin";

/** Engine-wide theme, sourced from the active skin. */
export const colors = skin.theme.colors;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const type = {
  title: { fontSize: 28, fontWeight: "700" as const, color: colors.textPrimary },
  heading: { fontSize: 20, fontWeight: "600" as const, color: colors.textPrimary },
  body: { fontSize: 16, color: colors.textPrimary },
  caption: { fontSize: 13, color: colors.textSecondary },
};
