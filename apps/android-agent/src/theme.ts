import { useColorScheme } from "react-native";

/**
 * Design tokens from docs/design.md — Inter, the navy/indigo/emerald/amber palette,
 * 8px radius, thin borders, "avoid glassmorphism/heavy animation." That document is
 * locked for every surface (dashboard, desktop agent, this app); the iOS-inspired
 * polish this file enables is structural — large titles, spacing rhythm, restrained
 * depth, spring motion — not a different color or type system.
 */

export const fontFamily = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
} as const;

/** Passed straight to `useFonts()` in App.tsx. */
export { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from "@expo-google-fonts/inter";

const accent = {
  navy: "#0F172A",
  /** Reserved for AI surfaces per docs/design.md — this agent has none, so it only ever appears as the primary action color. */
  indigo: "#6366F1",
  emerald: "#10B981",
  amber: "#F59E0B",
} as const;

interface Palette {
  background: string;
  card: string;
  border: string;
  foreground: string;
  muted: string;
  destructive: string;
  warningSurface: string;
}

const lightPalette: Palette = {
  background: "#F8FAFC",
  card: "#FFFFFF",
  border: "#E2E8F0",
  foreground: "#0F172A",
  muted: "#64748B",
  destructive: "#DC2626",
  warningSurface: "#FEF3C7",
};

const darkPalette: Palette = {
  background: "#020617",
  card: "#0F172A",
  border: "#1E293B",
  foreground: "#F1F5F9",
  muted: "#94A3B8",
  destructive: "#F87171",
  warningSurface: "#422006",
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

/** iOS HIG's named type scale, built on Inter at the doc's locked weights (600 headings, 500 labels, 400 body). */
export const typography = {
  largeTitle: { fontFamily: fontFamily.bold, fontSize: 34, lineHeight: 41 },
  title: { fontFamily: fontFamily.semibold, fontSize: 22, lineHeight: 28 },
  headline: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: fontFamily.regular, fontSize: 16, lineHeight: 22 },
  callout: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 21 },
  subhead: { fontFamily: fontFamily.medium, fontSize: 14, lineHeight: 19 },
  footnote: { fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fontFamily.medium, fontSize: 12, lineHeight: 16, letterSpacing: 0.2 },
} as const;

/** Locked at 8px per docs/design.md — do not scale this up for an "iOS" look. */
export const radius = 8;

/** iOS HIG's 44pt minimum, in RN's density-independent points. */
export const minTouchTarget = 44;

interface ShadowStyle {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

const shadow: { light: ShadowStyle; dark: ShadowStyle } = {
  light: {
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  dark: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 2,
  },
};

export interface Theme {
  mode: "light" | "dark";
  colors: Palette & typeof accent;
  spacing: typeof spacing;
  typography: typeof typography;
  radius: number;
  minTouchTarget: number;
  shadow: ShadowStyle;
}

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const mode = scheme === "dark" ? "dark" : "light";
  const palette = mode === "dark" ? darkPalette : lightPalette;

  return {
    mode,
    colors: { ...palette, ...accent },
    spacing,
    typography,
    radius,
    minTouchTarget,
    shadow: shadow[mode],
  };
}
