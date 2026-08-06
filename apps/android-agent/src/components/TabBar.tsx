import { Feather } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PressableScale } from "./PressableScale";
import { useTheme } from "../theme";

/**
 * The bottom tabs.
 *
 * Hand-rolled rather than pulled from a navigation library on purpose. `App.tsx`
 * already swaps screens from agent state instead of routing, and these four tabs have
 * no stacks, no params and no deep links between them — so a router would add a
 * dependency to a locked stack in exchange for nothing this app uses. If nested
 * navigation ever arrives, that trade changes and this should be replaced rather than
 * grown.
 */

export type TabKey = "today" | "activity" | "device" | "privacy";

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
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, theme.spacing.sm) }]}>
      {TABS.map((tab) => {
        const selected = tab.key === active;

        return (
          <PressableScale
            key={tab.key}
            onPress={() => onSelect(tab.key)}
            scaleTo={0.94}
            accessibilityRole="tab"
            // `selected` is what a screen reader announces; colour alone would leave
            // the current tab indistinguishable to anyone not relying on sight.
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
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography } = theme;

  return StyleSheet.create({
    bar: {
      flexDirection: "row",
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.card,
      paddingTop: spacing.sm,
    },
    tab: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
      // Comfortably past the 44pt minimum, because these sit at the very bottom of the
      // screen where thumbs are least accurate.
      minHeight: 48,
    },
    label: { ...typography.caption, color: colors.muted },
    labelSelected: { color: colors.indigo, fontWeight: "600" },
  });
}
