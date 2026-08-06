import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { PressableScale } from "../components/PressableScale";
import { useTheme, fontFamily } from "../theme";

interface LoginScreenProps {
  onLogin: (code: string) => Promise<void>;
}

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
        {/* Brand Header */}
        <View style={styles.brandHeader}>
          <View style={styles.logoContainer}>
            <View style={styles.logoOuter}>
              <View style={styles.logoInner}>
                <Feather name="shield" size={24} color={theme.colors.indigo} />
              </View>
            </View>
          </View>
          <Text style={styles.brandName}>AEMS COMPANION</Text>
        </View>

        <View style={styles.titleBlock}>
          <Text style={styles.largeTitle}>Sign in to this device</Text>
          <Text style={styles.body}>
            Signing in binds this phone to your employee account, so the work it
            reports is recorded under your name.
          </Text>
        </View>

        {/* Informational Callout Card */}
        <View style={styles.calloutCard}>
          <View style={styles.calloutHeader}>
            <Feather name="info" size={16} color={theme.colors.muted} />
            <Text style={styles.calloutTitle}>Instructions</Text>
          </View>
          <Text style={styles.calloutText}>
            Open the AEMS dashboard, go to <Text style={styles.semibold}>Devices → Add device</Text>, and paste the sign-in code it shows you.
          </Text>
        </View>

        {error ? (
          <View style={styles.errorCard}>
            <Feather name="alert-triangle" size={16} color={theme.colors.destructive} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.group}>
          <View style={styles.labelRow}>
            <Feather name="key" size={12} color={theme.colors.muted} />
            <Text style={styles.groupLabel}>SIGN-IN CODE</Text>
          </View>
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
          {busy ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <View style={styles.buttonContent}>
              <Text style={styles.buttonText}>Bind this device</Text>
              <Feather name="arrow-right" size={18} color="#FFFFFF" style={{ marginLeft: 6 }} />
            </View>
          )}
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
    content: { padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.lg },
    brandHeader: {
      alignItems: "center",
      marginTop: spacing.md,
      marginBottom: spacing.xs,
      gap: spacing.sm,
    },
    logoContainer: {
      alignItems: "center",
      justifyContent: "center",
    },
    logoOuter: {
      width: 56,
      height: 56,
      borderRadius: 16,
      backgroundColor: theme.mode === "dark" ? "#1E293B" : "#F1F5F9",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
    },
    logoInner: {
      width: 42,
      height: 42,
      borderRadius: 12,
      backgroundColor: colors.card,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: colors.indigo,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 2,
    },
    brandName: {
      fontFamily: theme.typography.title.fontFamily,
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 1.5,
      color: colors.indigo,
    },
    titleBlock: { gap: spacing.xs },
    largeTitle: { ...typography.largeTitle, color: colors.foreground, textAlign: "center" },
    body: { ...typography.body, color: colors.muted, textAlign: "center", paddingHorizontal: spacing.sm },
    calloutCard: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      padding: spacing.md,
      gap: spacing.xs,
    },
    calloutHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
    },
    calloutTitle: {
      ...typography.caption,
      color: colors.foreground,
      fontWeight: "600",
    },
    calloutText: { ...typography.footnote, color: colors.muted, lineHeight: 18 },
    semibold: { fontFamily: fontFamily.semibold, fontWeight: "600" },
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
    group: { gap: spacing.sm },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      marginLeft: spacing.xs,
    },
    groupLabel: {
      ...typography.caption,
      color: colors.muted,
      textTransform: "uppercase",
      fontWeight: "600",
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
    input: { ...typography.body, color: colors.foreground, paddingVertical: spacing.sm, textAlign: "center" },
    footnote: { ...typography.footnote, color: colors.muted, marginLeft: spacing.xs, marginTop: spacing.xs / 2 },
    button: {
      minHeight: minTouchTarget + 6,
      borderRadius: radius,
      backgroundColor: colors.indigo,
      alignItems: "center",
      justifyContent: "center",
      ...theme.shadow,
    },
    buttonDisabled: { opacity: 0.4 },
    buttonContent: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
    buttonText: { ...typography.headline, color: "#FFFFFF" },
    note: { ...typography.footnote, color: colors.muted, textAlign: "center", paddingHorizontal: spacing.md },
  });
}


