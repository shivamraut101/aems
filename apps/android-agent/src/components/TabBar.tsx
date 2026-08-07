import { BlurView } from "expo-blur";
import { Feather } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { LayoutChangeEvent, Platform, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PressableScale } from "./PressableScale";
import { useTheme } from "../theme";

/**
 * The bottom tabs, as a translucent capsule floating over the content.
 *
 * **This is a deliberate exception to `docs/design.md`**, which lists glassmorphism
 * under *Avoid* and locks the corner radius at 8px, and it is confined to this one
 * component — see the scope-decisions table in `CLAUDE.md`. Everywhere a reader has to
 * actually read something (consent, privacy, the break and revoked notices) stays on a
 * solid surface with the locked radius, because that Avoid rule is about legibility and
 * those are the screens where legibility decides whether somebody is treated fairly. A
 * navigation bar carries four words the reader already knows.
 *
 * The blur only means anything if there is something behind it, so this floats above
 * the screen rather than sitting in the layout, and every screen leaves
 * `useTabBarContentInset()` of room at the bottom of its scroll content. An opaque bar
 * in the flow would look identical and cost nothing — the translucency is the whole
 * reason for the extra plumbing.
 *
 * Hand-rolled rather than taken from a navigation library, as before: four tabs, no
 * stacks, no params, no deep links.
 */

export type TabKey = "today" | "activity" | "device" | "privacy";

/** The capsule's own height, before the gap it leaves under itself. */
const BAR_HEIGHT = 60;

/** How far the capsule is held off the left and right screen edges. */
const BAR_MARGIN = 16;

/**
 * A full capsule rather than a large-but-finite radius. Half the height is the only
 * value that stays a capsule when the height changes, so there is nothing to keep in
 * sync if the bar ever grows a row.
 */
const BAR_RADIUS = BAR_HEIGHT / 2;

/** Breathing room between the capsule's underside and whatever the system draws below. */
const BAR_GAP = 12;

/** How far the moving pill is held inside its tab slot, on every side. */
const PILL_INSET = 6;

/**
 * What a scroll view must leave clear so its last row is not trapped under the bar.
 *
 * A hook rather than a constant because a floating bar's clearance depends on the
 * safe-area inset it is sitting on top of — the old edge-to-edge bar absorbed that
 * inset into its own padding, and this one does not.
 */
export function useTabBarContentInset() {
  const insets = useSafeAreaInsets();
  return BAR_HEIGHT + BAR_GAP + Math.max(insets.bottom, BAR_GAP);
}

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

  // Measured rather than assumed: the capsule is `BAR_MARGIN` off each edge, so its
  // interior is a screen-width-dependent number no constant here could know.
  const [rowWidth, setRowWidth] = useState(0);
  const tabWidth = rowWidth / TABS.length;
  const activeIndex = Math.max(
    0,
    TABS.findIndex((tab) => tab.key === active),
  );

  const translateX = useSharedValue(0);
  const placed = useRef(false);

  useEffect(() => {
    if (tabWidth === 0) return;
    const target = activeIndex * tabWidth + PILL_INSET;

    // The first placement is a jump, not a spring. Springing means the pill slides in
    // from the left edge on the first frame the bar is measured, which reads as the app
    // animating something the employee did not do.
    if (!placed.current) {
      placed.current = true;
      translateX.value = target;
      return;
    }

    translateX.value = withSpring(target, { damping: 20, stiffness: 220, mass: 0.9 });
  }, [activeIndex, tabWidth, translateX]);

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    // Hidden until measured, so it never paints one frame in the wrong slot.
    opacity: tabWidth === 0 ? 0 : 1,
  }));

  const onRowLayout = (event: LayoutChangeEvent) => {
    setRowWidth(event.nativeEvent.layout.width);
  };

  return (
    <View
      style={[styles.wrapper, { paddingBottom: Math.max(insets.bottom, BAR_GAP) }]}
      pointerEvents="box-none"
    >
      <View style={styles.lift}>
        <View style={styles.capsule}>
          <BlurView
            // `dimezisBlurView` is what makes this a real backdrop blur on Android rather
            // than the flat translucent wash the default falls back to. Android 12 and
            // below take that fallback, which is a legible bar either way — just not a
            // glass one.
            experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined}
            intensity={theme.mode === "dark" ? 40 : 60}
            tint={theme.mode === "dark" ? "dark" : "light"}
            style={StyleSheet.absoluteFill}
          />

          {/*
            A tinted scrim under the icons. Blur alone leaves contrast at the mercy of
            whatever is scrolling behind — a chart or a bright card can wash the labels
            out entirely. This keeps the bar readable without making it opaque.
          */}
          <View style={styles.scrim} />

          <View style={styles.row} onLayout={onRowLayout}>
            {/*
              The selected tab's own glass pill, moving between slots. It sits under the
              icons and takes no touches, so the tab beneath it stays the thing you press.
            */}
            <Animated.View
              style={[styles.pill, { width: Math.max(tabWidth - PILL_INSET * 2, 0) }, pillStyle]}
              pointerEvents="none"
            />

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
                    size={20}
                    color={selected ? theme.colors.indigo : theme.colors.muted}
                  />
                  <Text style={[styles.label, selected && styles.labelSelected]}>{tab.label}</Text>
                </PressableScale>
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, typography } = theme;
  const dark = theme.mode === "dark";

  return StyleSheet.create({
    wrapper: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: BAR_MARGIN,
    },
    /**
     * Carries the shadow, and nothing else. It has to be a separate view from the one
     * that clips, because a shadow drawn on a view with `overflow: "hidden"` is clipped
     * away by that same rule.
     */
    lift: {
      borderRadius: BAR_RADIUS,
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: dark ? 0.45 : 0.14,
      shadowRadius: 16,
      elevation: 10,
    },
    capsule: {
      height: BAR_HEIGHT,
      borderRadius: BAR_RADIUS,
      overflow: "hidden",
      // A hairline rather than a 1px border: on a 3x screen `StyleSheet.hairlineWidth`
      // is the thinnest line the display can actually draw, which is what keeps the
      // capsule's edge reading as a highlight instead of an outline.
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: dark ? "rgba(255,255,255,0.14)" : "rgba(15,23,42,0.10)",
    },
    scrim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: dark ? "rgba(2,6,23,0.55)" : "rgba(248,250,252,0.6)",
    },
    row: { flex: 1, flexDirection: "row" },
    pill: {
      position: "absolute",
      top: PILL_INSET,
      bottom: PILL_INSET,
      left: 0,
      borderRadius: BAR_RADIUS - PILL_INSET,
      // Indigo is this app's primary action colour (see `theme.ts`), and the selected
      // icon and label already use it — the pill is the same signal at the lowest
      // opacity that still reads, not a second one.
      backgroundColor: dark ? "rgba(99,102,241,0.20)" : "rgba(99,102,241,0.12)",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: dark ? "rgba(148,151,255,0.30)" : "rgba(99,102,241,0.22)",
    },
    tab: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
    },
    label: { ...typography.caption, color: colors.muted, fontSize: 11 },
    labelSelected: { color: colors.indigo, fontWeight: "600" },
  });
}
