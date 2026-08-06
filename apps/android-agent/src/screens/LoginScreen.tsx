import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PressableScale } from "../components/PressableScale";
import { useTheme } from "../theme";

interface LoginScreenProps {
  onLogin: (code: string) => Promise<void>;
}

/**
 * Sign-in and device binding (scope §3.1).
 *
 * Mirrors the desktop agent's `LoginScreen.tsx`: the employee pastes the sign-in
 * code the web dashboard issues rather than typing a password here. The code is
 * sent as-is to `POST /api/devices/enroll-with-code` — see `state.ts`'s `login()`.
 */
export function LoginScreen({ onLogin }: LoginScreenProps) {
  const theme = useTheme();
  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = code.trim();
  const disabled = busy || trimmed.length === 0;

  async function submit() {
    if (disabled) return;

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

  const styles = createStyles(theme);

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.titleBlock}>
          <Text style={styles.largeTitle}>Sign in to this device</Text>
          <Text style={styles.body}>
            Signing in binds this phone to your employee account, so the work it
            reports is recorded under your name.
          </Text>
        </View>

        <Text style={styles.callout}>
          Open the AEMS dashboard, go to Devices → Add device, and paste the
          sign-in code it shows you.
        </Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.group}>
          <Text style={styles.groupLabel}>SIGN-IN CODE</Text>
          <View
            style={[
              styles.fieldCard,
              focused && styles.fieldCardFocused,
              theme.shadow,
            ]}
          >
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={setCode}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              placeholder="Paste the code from the dashboard"
              placeholderTextColor={theme.colors.muted}
            />
          </View>
          <Text style={styles.footnote}>
            The code expires shortly after the dashboard shows it. Generate a new
            one if this fails.
          </Text>
        </View>

        <PressableScale
          onPress={() => void submit()}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          style={[styles.button, disabled && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>{busy ? "Signing in…" : "Bind this device"}</Text>
        </PressableScale>

        <Text style={styles.note}>
          Nothing is recorded yet. The next screen sets out exactly what this
          agent collects, and you decide there.
        </Text>
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
    callout: { ...typography.callout, color: colors.muted, lineHeight: 21 },
    errorText: { ...typography.subhead, color: colors.destructive },
    group: { gap: spacing.sm },
    groupLabel: {
      ...typography.caption,
      color: colors.muted,
      marginLeft: spacing.xs,
      textTransform: "uppercase",
    },
    fieldCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      backgroundColor: colors.card,
      minHeight: minTouchTarget,
      justifyContent: "center",
      paddingHorizontal: spacing.md,
    },
    fieldCardFocused: { borderColor: colors.indigo, borderWidth: 1.5 },
    input: { ...typography.body, color: colors.foreground, paddingVertical: spacing.sm },
    footnote: { ...typography.footnote, color: colors.muted, marginLeft: spacing.xs },
    button: {
      minHeight: minTouchTarget,
      borderRadius: radius,
      backgroundColor: colors.indigo,
      alignItems: "center",
      justifyContent: "center",
      ...theme.shadow,
    },
    buttonDisabled: { opacity: 0.4 },
    buttonText: { ...typography.headline, color: "#FFFFFF" },
    note: { ...typography.footnote, color: colors.muted, textAlign: "center" },
  });
}
