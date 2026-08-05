import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PressableScale } from "../components/PressableScale";
import { useTheme } from "../theme";
import AemsUsage from "../../modules/aems-usage";
import type { AgentStatus } from "../state";

interface ConsentScreenProps {
  status: AgentStatus;
  onAccept: () => Promise<void>;
  onAccepted: () => void;
}

const DISCLOSURE_ITEMS = [
  "Which apps you use, and for how long",
  "Whether the device is online and its battery level",
  "Device model, Android version and storage",
  "When the app last synchronised with your employer",
];

/**
 * Consent gate.
 *
 * Nothing is collected before this is accepted, and there is no way back to it once
 * accepted. Everything the app will record is listed plainly — the list is the
 * disclosure, not a link to one.
 */
export function ConsentScreen({ status, onAccept, onAccepted }: ConsentScreenProps) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await onAccept();
      if (!AemsUsage.hasUsageAccess()) AemsUsage.requestUsageAccess();
      AemsUsage.startMonitoring();
      onAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const styles = createStyles(theme);

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleBlock}>
          <Text style={styles.largeTitle}>Before monitoring starts</Text>
          <Text style={styles.body}>
            This is a company-owned device. Once you agree, this app will record:
          </Text>
        </View>

        <View style={[styles.card, theme.shadow]}>
          {DISCLOSURE_ITEMS.map((item, index) => (
            <View
              key={item}
              style={[styles.row, index < DISCLOSURE_ITEMS.length - 1 && styles.rowDivider]}
            >
              <View style={styles.rowDot} />
              <Text style={styles.rowText}>{item}</Text>
            </View>
          ))}
        </View>

        <View style={styles.footnoteBlock}>
          <Text style={styles.footnote}>
            A notification stays visible the whole time monitoring is running. You
            can withdraw consent at any time from the web dashboard, which stops
            collection immediately.
          </Text>
          <Text style={styles.caption}>POLICY VERSION {status.policyVersion ?? "—"}</Text>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <PressableScale
          onPress={() => void accept()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          style={[styles.button, busy && styles.buttonDisabled, theme.shadow]}
        >
          <Text style={styles.buttonText}>{busy ? "Saving…" : "I understand and agree"}</Text>
        </PressableScale>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography, radius, minTouchTarget } = theme;

  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, paddingTop: spacing.md, gap: spacing.lg },
    titleBlock: { gap: spacing.sm },
    largeTitle: { ...typography.largeTitle, color: colors.foreground },
    body: { ...typography.body, color: colors.foreground },
    card: {
      borderRadius: radius,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: minTouchTarget,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    rowDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.indigo },
    rowText: { ...typography.callout, color: colors.foreground, flex: 1 },
    footnoteBlock: { gap: spacing.xs },
    footnote: { ...typography.footnote, color: colors.muted },
    caption: { ...typography.caption, color: colors.muted },
    errorText: { ...typography.subhead, color: colors.destructive },
    button: {
      minHeight: minTouchTarget,
      borderRadius: radius,
      backgroundColor: colors.indigo,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonDisabled: { opacity: 0.4 },
    buttonText: { ...typography.headline, color: "#FFFFFF" },
  });
}
