import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import AemsUsage from "../../modules/aems-usage";
import { colors, spacing } from "../theme";
import type { AgentStatus } from "../state";

interface ConsentScreenProps {
  status: AgentStatus;
  onAccept: () => Promise<void>;
  onAccepted: () => void;
}

/**
 * Consent gate.
 *
 * Nothing is collected before this is accepted, and there is no way back to it once
 * accepted. Everything the app will record is listed plainly — the list is the
 * disclosure, not a link to one.
 */
export function ConsentScreen({ status, onAccept, onAccepted }: ConsentScreenProps) {
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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Before monitoring starts</Text>

      <Text style={styles.body}>
        This is a company-owned device. Once you agree, this app will record:
      </Text>

      <View style={styles.list}>
        {[
          "Which apps you use, and for how long",
          "Whether the device is online and its battery level",
          "Device model, Android version and storage",
          "When the app last synchronised with your employer",
        ].map((item) => (
          <View key={item} style={styles.listRow}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.listText}>{item}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.note}>
        A notification stays visible the whole time monitoring is running. You can
        withdraw consent at any time from the web dashboard, which stops collection
        immediately. Policy version {status.policyVersion ?? "—"}.
      </Text>

      <Pressable
        onPress={() => void accept()}
        disabled={busy}
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>{busy ? "Saving…" : "I understand and agree"}</Text>
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  title: { color: colors.foreground, fontSize: 22, fontWeight: "600" },
  body: { color: colors.foreground, fontSize: 15, lineHeight: 22 },
  list: { gap: 8 },
  listRow: { flexDirection: "row", gap: 8 },
  bullet: { color: colors.muted },
  listText: { color: colors.foreground, flex: 1, lineHeight: 21 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  button: {
    marginTop: spacing.sm,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: colors.indigo,
    alignItems: "center",
  },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  error: { color: colors.destructive, fontSize: 13 },
});
