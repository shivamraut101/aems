import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { TAB_BAR_CONTENT_INSET } from "./TabBar";
import { useTheme } from "../theme";

const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

/**
 * The screen frame every tab sits in: an iOS large title that hands over to a compact
 * header as the page scrolls.
 *
 * The handover is the whole trick. A large title is generous with space when there is
 * space to be generous with, and gets out of the way the moment the reader is actually
 * reading — and because the compact bar only appears once the large one has left, the
 * title is never on screen twice.
 *
 * Both crossfades run on the UI thread through Reanimated rather than on scroll events
 * in JavaScript. On a header tied to finger position that distinction is visible: a
 * JS-driven fade stutters whenever the bridge is busy, which on this app is every sync
 * cycle.
 */

/** Scroll distance over which the large title gives way. Roughly its own height. */
const HANDOVER_START = 16;
const HANDOVER_END = 56;

interface ScreenProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onRefresh?: () => Promise<void>;
  /** Screens outside the tab bar (login, consent, revoked) do not need its clearance. */
  tabbed?: boolean;
  /**
   * Drawn beside the large title, the way iOS puts an avatar or status pill there.
   * It scrolls away with the title rather than pinning, so the compact bar stays a
   * single uncluttered line.
   */
  accessory?: React.ReactNode;
}

export function Screen({
  title,
  subtitle,
  children,
  onRefresh,
  tabbed = true,
  accessory,
}: ScreenProps) {
  const theme = useTheme();
  const styles = createStyles(theme);

  const scrollY = useSharedValue(0);
  const [refreshing, setRefreshing] = useState(false);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  const compactStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value,
      [HANDOVER_START, HANDOVER_END],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const largeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value,
      [HANDOVER_START, HANDOVER_END],
      [1, 0],
      Extrapolation.CLAMP,
    ),
    // Drifting up as it fades is what makes it read as the title *moving* into the bar
    // rather than one element disappearing while another appears.
    transform: [
      {
        translateY: interpolate(
          scrollY.value,
          [HANDOVER_START, HANDOVER_END],
          [0, -8],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  const handleRefresh = useCallback(async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      {/*
        Kept out of the scroll view so it stays put, and `pointerEvents="none"` so it
        never swallows a touch meant for the row passing underneath it.
      */}
      <Animated.View style={[styles.compactBar, compactStyle]} pointerEvents="none">
        <Text style={styles.compactTitle} numberOfLines={1}>
          {title}
        </Text>
      </Animated.View>

      <AnimatedScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: tabbed ? TAB_BAR_CONTENT_INSET + theme.spacing.lg : theme.spacing.xl },
        ]}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.muted}
            />
          ) : undefined
        }
      >
        <Animated.View style={[styles.titleBlock, largeStyle]}>
          <View style={styles.titleRow}>
            <Text style={styles.largeTitle} numberOfLines={1}>
              {title}
            </Text>
            {accessory}
          </View>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </Animated.View>

        {children}
      </AnimatedScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography } = theme;

  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    compactBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      zIndex: 2,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.lg,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      alignItems: "center",
    },
    compactTitle: { ...typography.headline, color: colors.foreground },
    content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.lg },
    titleBlock: { gap: spacing.xs, marginBottom: -spacing.xs },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    largeTitle: { ...typography.largeTitle, color: colors.foreground, flexShrink: 1 },
    subtitle: { ...typography.footnote, color: colors.muted, lineHeight: 19 },
  });
}
