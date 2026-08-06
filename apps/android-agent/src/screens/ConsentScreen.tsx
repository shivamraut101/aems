import { useState } from "react";
import { ScrollView, StyleSheet, Text, View, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

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
  {
    text: "Which apps you use, and for how long",
    icon: "activity" as const,
    description: "Tracks active application foreground time to log work duration.",
  },
  {
    text: "Whether the device is online and battery level",
    icon: "battery" as const,
    description: "Monitors sync availability and power status for heartbeat signals.",
  },
  {
    text: "Device model, Android version and storage",
    icon: "smartphone" as const,
    description: "Registers device hardware metadata to help identify your phone.",
  },
  {
    text: "When the app last synchronised",
    icon: "refresh-cw" as const,
    description: "Keeps a history of successful connections with the server.",
  },
];

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
      // Starting the foreground service is deliberately *not* done here. `onAccept`
      // has just set `collecting`, and App.tsx starts and stops the service from that
      // one flag — so it also comes back on the launches this handler never sees.
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
        <View style={styles.brandHeader}>
          <View style={styles.iconContainer}>
            <Feather name="shield" size={32} color={theme.colors.indigo} />
          </View>
        </View>

        <View style={styles.titleBlock}>
          <Text style={styles.largeTitle}>Before monitoring starts</Text>
          <Text style={styles.body}>
            This is a company-owned device. Once you agree, this companion app will record the following:
          </Text>
        </View>

        <View style={styles.cardList}>
          {DISCLOSURE_ITEMS.map((item, index) => (
            <View key={item.text} style={[styles.disclosureCard, theme.shadow]}>
              <View style={styles.cardHeader}>
                <View style={styles.cardIconBox}>
                  <Feather name={item.icon} size={16} color={theme.colors.indigo} />
                </View>
                <View style={styles.cardTextContent}>
                  <Text style={styles.cardTextTitle}>{item.text}</Text>
                  <Text style={styles.cardTextDesc}>{item.description}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.footnoteBlock}>
          <View style={styles.infoRow}>
            <Feather name="bell" size={14} color={theme.colors.muted} />
            <Text style={styles.footnote}>
              A persistent notification stays visible the whole time monitoring is running.
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Feather name="x-circle" size={14} color={theme.colors.muted} />
            <Text style={styles.footnote}>
              You can withdraw consent at any time from the web dashboard, which stops collection immediately.
            </Text>
          </View>
          <Text style={styles.caption}>POLICY VERSION {status.policyVersion ?? "—"}</Text>
        </View>

        {error ? (
          <View style={styles.errorCard}>
            <Feather name="alert-triangle" size={16} color={theme.colors.destructive} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <PressableScale
          onPress={() => void accept()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          style={[styles.button, busy && styles.buttonDisabled, theme.shadow]}
        >
          {busy ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <View style={styles.buttonContent}>
              <Text style={styles.buttonText}>I understand and agree</Text>
              <Feather name="check" size={18} color="#FFFFFF" style={{ marginLeft: 6 }} />
            </View>
          )}
        </PressableScale>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography, radius, minTouchTarget } = theme;

  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.lg },
    brandHeader: {
      alignItems: "center",
      marginTop: spacing.sm,
      marginBottom: spacing.xs,
    },
    iconContainer: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.mode === "dark" ? "#1E293B" : "#EEF2F6",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
    },
    titleBlock: { gap: spacing.xs },
    largeTitle: { ...typography.largeTitle, color: colors.foreground, textAlign: "center" },
    body: { ...typography.body, color: colors.muted, textAlign: "center", paddingHorizontal: spacing.sm },
    cardList: { gap: spacing.sm },
    disclosureCard: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      padding: spacing.md,
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.md,
    },
    cardIconBox: {
      width: 32,
      height: 32,
      borderRadius: radius,
      backgroundColor: theme.mode === "dark" ? "#1E293B" : "#F1F5F9",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
      marginTop: 2,
    },
    cardTextContent: { flex: 1, gap: 2 },
    cardTextTitle: { ...typography.subhead, color: colors.foreground, fontWeight: "600" },
    cardTextDesc: { ...typography.footnote, color: colors.muted, lineHeight: 16 },
    footnoteBlock: {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius,
      padding: spacing.md,
      gap: spacing.sm,
    },
    infoRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
    footnote: { ...typography.footnote, color: colors.muted, flex: 1, lineHeight: 18 },
    caption: { ...typography.caption, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: spacing.xs / 2 },
    errorCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      backgroundColor: theme.mode === "dark" ? "#311" : "#FEF2F2",
      borderColor: colors.destructive,
      borderWidth: 1,
      borderRadius: radius,
      padding: spacing.md,
    },
    errorText: { ...typography.subhead, color: colors.destructive, flex: 1 },
    button: {
      minHeight: minTouchTarget + 6,
      borderRadius: radius,
      backgroundColor: colors.indigo,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonDisabled: { opacity: 0.4 },
    buttonContent: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
    buttonText: { ...typography.headline, color: "#FFFFFF" },
  });
}

