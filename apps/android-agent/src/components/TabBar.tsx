import { BlurView } from "expo-blur";
import { Feather } from "@expo/vector-icons";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PressableScale } from "./PressableScale";
import { useTheme } from "../theme";

/**
 * The bottom tabs, as a translucent bar the content passes underneath.
 *
 * **This is a deliberate exception to `docs/design.md`**, which lists glassmorphism
 * under *Avoid*, and it is confined to this one component — see the scope-decisions
 * table in `CLAUDE.md`. Everywhere a reader has to actually read something (consent,
 * privacy, the break and revoked notices) stays on a solid surface, because that Avoid
 * rule is about legibility and those are the screens where legibility decides whether
 * somebody is treated fairly.
 *
 * The blur only means anything if there is something behind it, so this floats above
 * the screen rather than sitting in the layout, and every screen leaves
 * `TAB_BAR_CONTENT_INSET` of room at the bottom of its scroll content. An opaque bar
 * in the flow would look identical and cost nothing — the translucency is the whole
 * reason for the extra plumbing.
 *
 * Hand-rolled rather than taken from a navigation library, as before: four tabs, no
 * stacks, no params, no deep links.
 */

export type TabKey = "today" | "activity" | "device" | "privacy";

/** Bar height above the safe-area inset. Screens add their own inset on top of this. */
const BAR_HEIGHT = 56;

/** What a scroll view must leave clear so its last row is not trapped under the bar. */
export const TAB_BAR_CONTENT_INSET = BAR_HEIGHT + 16;

interface TabDefinition {
  key: TabKey;
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
}

export const TABS: TabDefinition[] = [
  { key: "today", label: "Today", icon: "home" },
  { key: "activity", label: "Activity", icon: "bar-chart-2" },
  { key: "device", label: "Device", icon: "smartphone" },
  { key: "privacy", label: "Privacy", icon: "shield" },
];

export function TabBar({
  active,
  onSelect,
}: {
  active: TabKey;
  onSelect: (key: TabKey) => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme);

  return (
    <View style={styles.wrapper} pointerEvents="box-none">
      <BlurView
        // `dimezisBlurView` is what makes this a real backdrop blur on Android rather
        // than the flat translucent wash the default falls back to. Android 12 and
        // below take that fallback, which is a legible bar either way — just not a
        // glass one.
        experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined}
        intensity={theme.mode === "dark" ? 40 : 60}
        tint={theme.mode === "dark" ? "dark" : "light"}
        style={styles.blur}
      >
        {/*
          A tinted scrim under the icons. Blur alone leaves contrast at the mercy of
          whatever is scrolling behind — a chart or a bright card can wash the labels
          out entirely. This keeps the bar readable without making it opaque.
        */}
        <View style={styles.scrim} />

        <View style={[styles.row, { paddingBottom: Math.max(insets.bottom, theme.spacing.sm) }]}>
          {TABS.map((tab) => {
            const selected = tab.key === active;

            return (
              <PressableScale
                key={tab.key}
                onPress={() => onSelect(tab.key)}
                scaleTo={0.9}
                accessibilityRole="tab"
                // Announced by a screen reader; colour alone would leave the current
                // tab indistinguishable to anyone not relying on sight.
                accessibilityState={{ selected }}
                accessibilityLabel={tab.label}
                style={styles.tab}
              >
                <Feather
                  name={tab.icon}
                  size={22}
                  color={selected ? theme.colors.indigo : theme.colors.muted}
                />
                <Text style={[styles.label, selected && styles.labelSelected]}>{tab.label}</Text>
              </PressableScale>
            );
          })}
        </View>
      </BlurView>
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, typography } = theme;

  return StyleSheet.create({
    wrapper: { position: "absolute", left: 0, right: 0, bottom: 0 },
    blur: { overflow: "hidden" },
    scrim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.mode === "dark" ? "rgba(2,6,23,0.55)" : "rgba(248,250,252,0.6)",
    },
    row: {
      flexDirection: "row",
      paddingTop: 8,
      // A hairline rather than a 1px border: on a 3x screen `StyleSheet.hairlineWidth`
      // is the thinnest line the display can actually draw, which is what keeps an
      // iOS separator reading as a seam instead of a rule.
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.mode === "dark" ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.12)",
    },
    tab: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
      minHeight: 48,
    },
    label: { ...typography.caption, color: colors.muted, fontSize: 11 },
    labelSelected: { color: colors.indigo, fontWeight: "600" },
  });
}
