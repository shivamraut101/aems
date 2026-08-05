import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, spacing } from "../theme";

interface LoginScreenProps {
  onLogin: (accessToken: string) => Promise<void>;
}

/**
 * Sign-in and device binding (scope §3.1).
 *
 * Mirrors the desktop agent's `LoginScreen.tsx`: the employee pastes the sign-in
 * code the web dashboard issues rather than typing a password here. Nothing this
 * screen sends is stored on the device beyond the enrolment call it triggers —
 * see `state.ts`'s `login()` for why the token itself never touches disk.
 */
export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = code.trim();

  async function submit() {
    if (trimmed.length === 0 || busy) return;

    setBusy(true);
    setError(null);

    try {
      await onLogin(trimmed);
      // Left set on success: the screen is being replaced, and re-enabling the
      // input first would invite a second enrolment of a device that already has
      // one pending.
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "This device could not be signed in. Check the code and your connection, then try again.",
      );
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Sign in to this device</Text>

        <Text style={styles.body}>
          Signing in binds this phone to your employee account, so the work it reports
          is recorded under your name.
        </Text>
        <Text style={styles.body}>
          Open the AEMS dashboard, go to Devices → Add device, and paste the sign-in
          code it shows you.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.field}>
          <Text style={styles.label}>Sign-in code</Text>
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            placeholder="Paste the code from the dashboard"
            placeholderTextColor={colors.muted}
          />
          <Text style={styles.hint}>
            The code expires shortly after the dashboard shows it. Generate a new one
            if this fails.
          </Text>
        </View>

        <Pressable
          onPress={() => void submit()}
          disabled={busy || trimmed.length === 0}
          style={({ pressed }) => [
            styles.button,
            (pressed || busy || trimmed.length === 0) && styles.buttonPressed,
          ]}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>{busy ? "Signing in…" : "Bind this device"}</Text>
        </Pressable>

        <Text style={styles.note}>
          Nothing is recorded yet. The next screen sets out exactly what this agent
          collects, and you decide there.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  title: { color: colors.foreground, fontSize: 22, fontWeight: "600" },
  body: { color: colors.foreground, fontSize: 15, lineHeight: 22 },
  field: { gap: 6 },
  label: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.foreground,
    backgroundColor: colors.card,
  },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  button: {
    marginTop: spacing.sm,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: colors.indigo,
    alignItems: "center",
  },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  error: { color: colors.destructive, fontSize: 13 },
});
