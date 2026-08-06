import { Feather } from "@expo/vector-icons";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../theme";

/**
 * Shown when an administrator has stopped this device.
 *
 * This screen exists because of what used to happen instead: `sync.ts` cleared the
 * credentials and the employee was returned to the sign-in form with no explanation,
 * which reads as the app breaking rather than as a decision somebody made. The
 * desktop agent has always said so plainly; this is the same account, in the same
 * words, on the surface a phone user actually has.
 *
 * There is no action on it on purpose. Nothing the employee can do from here would
 * change the outcome — re-enrolling needs a new code, and issuing one is the
 * administrator's call — so offering a button would only invite a dead end. The one
 * useful thing it can do is name who to ask.
 */
export function RevokedScreen({ policyVersion }: { policyVersion: string | null }) {
  const theme = useTheme();
  const styles = createStyles(theme);

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.iconWrap}>
          <Feather name="slash" size={28} color={theme.colors.amber} />
        </View>

        <View style={styles.titleBlock}>
          <Text style={styles.title}>Monitoring has been stopped</Text>
          <Text style={styles.body}>
            An administrator revoked this device, so nothing is being recorded or sent.
            Contact them if you think this is a mistake.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Feather name="pause-circle" size={16} color={theme.colors.muted} />
            <Text style={styles.rowText}>Collection has stopped on this phone.</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Feather name="database" size={16} color={theme.colors.muted} />
            <Text style={styles.rowText}>
              Work already recorded stays in your company&rsquo;s records, and you can still
              read it from the AEMS dashboard.
            </Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Feather name="key" size={16} color={theme.colors.muted} />
            <Text style={styles.rowText}>
              To use this phone for work again, ask your administrator for a new sign-in
              code.
            </Text>
          </View>
        </View>

        {policyVersion ? (
          <Text style={styles.footnote}>Last policy in force · version {policyVersion}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography, radius } = theme;

  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.lg },
    iconWrap: {
      width: 56,
      height: 56,
      borderRadius: 16,
      alignSelf: "center",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.warningSurface,
    },
    titleBlock: { gap: spacing.sm },
    title: { ...typography.title, color: colors.foreground, textAlign: "center" },
    body: { ...typography.body, color: colors.muted, textAlign: "center" },
    card: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      paddingHorizontal: spacing.md,
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    rowText: { ...typography.footnote, color: colors.foreground, flex: 1, lineHeight: 19 },
    divider: { height: 1, backgroundColor: colors.border },
    footnote: { ...typography.footnote, color: colors.muted, textAlign: "center" },
  });
}
