import { StyleSheet, Text, View } from "react-native";

import { ListRow, ListSection } from "../components/List";
import { PressableScale } from "../components/PressableScale";
import { Screen } from "../components/Screen";
import { useTheme, useThemePreference, type ThemePreference } from "../theme";

/**
 * What is collected, under which policy, and how to stop it — available at any time
 * rather than only during onboarding.
 *
 * The consent screen sets all this out once, before collection starts, and is then
 * never seen again. That is the right moment to *ask* and the wrong place to leave the
 * only copy of the answer: the person most likely to want it is someone three weeks in
 * who is now wondering. Restating it costs nothing and is the whole point of the
 * compliance framing in `docs/design.md`.
 *
 * The appearance control lives here rather than on a settings screen of its own,
 * because it is the only preference this app has and a screen holding one switch is
 * worse than a section holding it.
 */

const COLLECTED = [
  {
    icon: "grid" as const,
    label: "Apps you use",
    detail: "Which apps are open and for how long. Not what you type, see, or send in them.",
  },
  {
    icon: "clock" as const,
    label: "Working time",
    detail: "When your day starts and ends, breaks you declare, and time the screen is in use.",
  },
  {
    icon: "smartphone" as const,
    label: "This device",
    detail: "Model, Android version, memory, storage, battery and network.",
  },
  {
    icon: "refresh-cw" as const,
    label: "Sync history",
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
    <Screen
      title="Privacy"
      subtitle="What this app records while you are working, and what it never touches."
    >
      <ListSection heading="What is recorded">
        {COLLECTED.map((item) => (
          <ListRow key={item.label} icon={item.icon} label={item.label} detail={item.detail} />
        ))}
      </ListSection>

      <ListSection heading="What is never recorded">
        {NOT_COLLECTED.map((line) => (
          <ListRow key={line} icon="x" iconColor={theme.colors.emerald} label={line} />
        ))}
      </ListSection>

      <ListSection
        heading="Your control"
        footnote={policyVersion ? `Policy in force · version ${policyVersion}` : undefined}
      >
        <ListRow
          icon="eye"
          label="Read your own record"
          detail="You can read everything recorded about you in the AEMS dashboard."
        />
        <ListRow
          icon="slash"
          label="Withdraw consent"
          detail="You can withdraw at any time from the AEMS dashboard. Collection on this phone stops at its next request."
        />
      </ListSection>

      <View style={styles.section}>
        <Text style={styles.heading}>Appearance</Text>
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
        <Text style={styles.footnote}>System follows the appearance set for this phone.</Text>
      </View>
    </Screen>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography, radius, minTouchTarget } = theme;

  return StyleSheet.create({
    section: { gap: spacing.sm },
    heading: {
      ...typography.caption,
      color: colors.muted,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      marginLeft: spacing.md,
    },
    // iOS's segmented control: one recessed track, the selection riding inside it.
    segmented: {
      flexDirection: "row",
      gap: 2,
      backgroundColor: theme.mode === "dark" ? "#1E293B" : "#E2E8F0",
      borderRadius: radius + 2,
      padding: 3,
    },
    segment: {
      flex: 1,
      minHeight: minTouchTarget - 10,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius,
    },
    segmentSelected: {
      backgroundColor: colors.card,
      ...theme.shadow,
    },
    segmentText: { ...typography.subhead, color: colors.muted },
    segmentTextSelected: { color: colors.foreground, fontWeight: "600" },
    footnote: {
      ...typography.footnote,
      color: colors.muted,
      marginLeft: spacing.md,
      marginTop: -spacing.xs,
    },
  });
}
