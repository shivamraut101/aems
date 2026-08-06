import { Feather } from "@expo/vector-icons";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PressableScale } from "../components/PressableScale";
import { useTheme, useThemePreference, type ThemePreference } from "../theme";

/**
 * What is collected, under which policy, and how to stop it — available at any time
 * rather than only during onboarding.
 *
 * The consent screen sets all this out once, before collection starts, and is then
 * never seen again. That is the right moment to *ask*, and the wrong place to leave
 * the only copy of the answer: the person most likely to want it is someone three
 * weeks in who is now wondering. Restating it here costs nothing and is the whole
 * point of the compliance framing in `docs/design.md`.
 *
 * The appearance control lives here rather than in a settings screen of its own,
 * because it is the only preference this app has and a screen holding one switch is
 * worse than a section holding it.
 */

const COLLECTED = [
  {
    icon: "grid" as const,
    title: "Apps you use",
    detail: "Which apps are open and for how long. Not what you type, see, or send in them.",
  },
  {
    icon: "clock" as const,
    title: "Working time",
    detail: "When your day starts and ends, breaks you declare, and time the screen is in use.",
  },
  {
    icon: "smartphone" as const,
    title: "This device",
    detail: "Model, Android version, memory, storage, battery and network — shown in full on the Device tab.",
  },
  {
    icon: "refresh-cw" as const,
    title: "Sync history",
    detail: "When this phone last reached the server, so your company knows it is online.",
  },
];

const NOT_COLLECTED = [
  "The contents of messages, emails, photos or files",
  "Anything you type, including passwords",
  "Your location",
  "Personal use outside a working day you have started",
];

export function PrivacyScreen({ policyVersion }: { policyVersion: string | null }) {
  const theme = useTheme();
  const { preference, setPreference } = useThemePreference();
  const styles = createStyles(theme);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Privacy</Text>
          <Text style={styles.subtitle}>
            What this app records while you are working, and what it never touches.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>WHAT IS RECORDED</Text>
          <View style={styles.card}>
            {COLLECTED.map((item, index) => (
              <View key={item.title} style={[styles.item, index < COLLECTED.length - 1 && styles.divider]}>
                <Feather name={item.icon} size={16} color={theme.colors.muted} />
                <View style={styles.itemText}>
                  <Text style={styles.itemTitle}>{item.title}</Text>
                  <Text style={styles.itemDetail}>{item.detail}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>WHAT IS NEVER RECORDED</Text>
          <View style={styles.card}>
            {NOT_COLLECTED.map((line, index) => (
              <View key={line} style={[styles.item, index < NOT_COLLECTED.length - 1 && styles.divider]}>
                <Feather name="x" size={16} color={theme.colors.emerald} />
                <Text style={styles.itemPlain}>{line}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>YOUR CONTROL</Text>
          <View style={styles.card}>
            <View style={[styles.item, styles.divider]}>
              <Feather name="eye" size={16} color={theme.colors.muted} />
              <Text style={styles.itemPlain}>
                You can read everything recorded about you in the AEMS dashboard.
              </Text>
            </View>
            <View style={styles.item}>
              <Feather name="slash" size={16} color={theme.colors.muted} />
              <Text style={styles.itemPlain}>
                You can withdraw your consent at any time from the AEMS dashboard. Collection
                on this phone stops at its next request.
              </Text>
            </View>
          </View>
          {policyVersion ? (
            <Text style={styles.footnote}>Policy in force · version {policyVersion}</Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>APPEARANCE</Text>
          <View style={styles.segmented}>
            {(["system", "light", "dark"] as ThemePreference[]).map((option) => {
              const selected = preference === option;
              return (
                <PressableScale
                  key={option}
                  onPress={() => setPreference(option)}
                  scaleTo={0.96}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={[styles.segment, selected && styles.segmentSelected]}
                >
                  <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                    {option === "system" ? "System" : option === "light" ? "Light" : "Dark"}
                  </Text>
                </PressableScale>
              );
            })}
          </View>
          <Text style={styles.footnote}>
            System follows the appearance set for this phone.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography, radius, minTouchTarget } = theme;

  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl },
    header: { gap: spacing.xs },
    title: { ...typography.title, color: colors.foreground },
    subtitle: { ...typography.footnote, color: colors.muted, lineHeight: 19 },
    section: { gap: spacing.sm },
    sectionHeader: {
      ...typography.caption,
      color: colors.muted,
      letterSpacing: 0.6,
      marginLeft: spacing.xs,
    },
    card: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      paddingHorizontal: spacing.md,
    },
    item: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    divider: { borderBottomWidth: 1, borderBottomColor: colors.border },
    itemText: { flex: 1, gap: 2 },
    itemTitle: { ...typography.subhead, color: colors.foreground },
    itemDetail: { ...typography.footnote, color: colors.muted, lineHeight: 18 },
    itemPlain: { ...typography.footnote, color: colors.foreground, flex: 1, lineHeight: 18 },
    footnote: { ...typography.footnote, color: colors.muted, marginLeft: spacing.xs },
    segmented: {
      flexDirection: "row",
      gap: spacing.xs,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      padding: spacing.xs,
    },
    segment: {
      flex: 1,
      minHeight: minTouchTarget - 8,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius - 2,
    },
    segmentSelected: { backgroundColor: colors.indigo },
    segmentText: { ...typography.subhead, color: colors.muted },
    segmentTextSelected: { color: "#FFFFFF", fontWeight: "600" },
  });
}
