import * as Battery from "expo-battery";
import * as Network from "expo-network";
import * as Notifications from "expo-notifications";
import { Feather } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { AppState, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import AemsUsage, { type DeviceSnapshot } from "../../modules/aems-usage";
import { PressableScale } from "../components/PressableScale";
import { useTheme } from "../theme";

/**
 * The device inventory `docs/scope.md` §3.4 specifies, plus the permissions the agent
 * depends on.
 *
 * Both halves answer the same question — "what does this phone tell my employer about
 * itself, and what is it allowed to see?" — so they belong on one screen rather than
 * split between an inventory page and a settings page.
 *
 * The permission rows follow the desktop agent's pattern: state the gap in plain terms,
 * say what stops working because of it, and offer the one control that fixes it.
 */

interface Readout {
  snapshot: DeviceSnapshot | null;
  batteryLevel: number;
  batteryState: Battery.BatteryState;
  network: Network.NetworkStateType;
  usageAccess: boolean;
  notificationsGranted: boolean;
}

export function DeviceScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);

  const [readout, setReadout] = useState<Readout | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [snapshot, batteryLevel, batteryState, network, notificationPermission] =
      await Promise.all([
        AemsUsage.getDeviceSnapshot().catch(() => null),
        Battery.getBatteryLevelAsync().catch(() => -1),
        Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
        Network.getNetworkStateAsync().catch(() => ({ type: undefined })),
        Notifications.getPermissionsAsync().catch(() => ({ granted: false })),
      ]);

    setReadout({
      snapshot,
      batteryLevel,
      batteryState,
      network: network.type ?? Network.NetworkStateType.UNKNOWN,
      usageAccess: AemsUsage.hasUsageAccess(),
      notificationsGranted: notificationPermission.granted,
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Both permissions are granted in system settings, which means leaving the app and
  // coming back. Without this the screen would still show the old answer on return.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void load();
    });
    return () => subscription.remove();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const snapshot = readout?.snapshot ?? null;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.muted} />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>This device</Text>
          <Text style={styles.subtitle}>
            The hardware and status details reported alongside your work.
          </Text>
        </View>

        <Section theme={theme} heading="HARDWARE">
          <Row theme={theme} icon="smartphone" label="Model" value={snapshot?.model ?? "—"} />
          <Row theme={theme} icon="cpu" label="Manufacturer" value={snapshot?.manufacturer ?? "—"} />
          <Row
            theme={theme}
            icon="layers"
            label="Android version"
            value={snapshot ? `Android ${snapshot.androidVersion}` : "—"}
          />
          <Row
            theme={theme}
            icon="server"
            label="Memory"
            value={snapshot ? formatMb(snapshot.totalRamMb) : "—"}
            last
          />
        </Section>

        <Section theme={theme} heading="STORAGE & POWER">
          <Row
            theme={theme}
            icon="hard-drive"
            label="Storage"
            value={
              snapshot
                ? `${formatMb(snapshot.freeStorageMb)} free of ${formatMb(snapshot.totalStorageMb)}`
                : "—"
            }
          />
          <Row
            theme={theme}
            icon="battery"
            label="Battery"
            value={readout ? formatBattery(readout.batteryLevel, readout.batteryState) : "—"}
          />
          <Row
            theme={theme}
            icon="wifi"
            label="Network"
            value={readout ? formatNetwork(readout.network) : "—"}
            last
          />
        </Section>

        <Section theme={theme} heading="PERMISSIONS">
          <PermissionRow
            theme={theme}
            granted={readout?.usageAccess ?? true}
            label="App usage access"
            grantedNote="Working. App usage is being recorded."
            deniedNote="Turned off. No app usage can be recorded until this is granted."
            onFix={() => AemsUsage.requestUsageAccess()}
          />
          <PermissionRow
            theme={theme}
            granted={readout?.notificationsGranted ?? true}
            label="Notifications"
            grantedNote="Working. The monitoring notice stays visible while recording."
            // Not a nicety: the notification is the visible indicator this product is
            // required to keep showing, so a denial is a compliance gap and is worded
            // as one rather than as a missed alert.
            deniedNote="Turned off. Monitoring cannot show its notice on this phone — ask your administrator before continuing."
            onFix={() => void Notifications.requestPermissionsAsync()}
            last
          />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({
  theme,
  heading,
  children,
}: {
  theme: ReturnType<typeof useTheme>;
  heading: string;
  children: React.ReactNode;
}) {
  const styles = createStyles(theme);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeader}>{heading}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  theme,
  icon,
  label,
  value,
  last,
}: {
  theme: ReturnType<typeof useTheme>;
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  value: string;
  last?: boolean;
}) {
  const styles = createStyles(theme);
  return (
    <View style={[styles.row, !last && styles.rowDivider]}>
      <Feather name={icon} size={16} color={theme.colors.muted} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function PermissionRow({
  theme,
  granted,
  label,
  grantedNote,
  deniedNote,
  onFix,
  last,
}: {
  theme: ReturnType<typeof useTheme>;
  granted: boolean;
  label: string;
  grantedNote: string;
  deniedNote: string;
  onFix: () => void;
  last?: boolean;
}) {
  const styles = createStyles(theme);

  return (
    <View style={[styles.permission, !last && styles.rowDivider]}>
      <View style={styles.permissionHeader}>
        <Feather
          name={granted ? "check-circle" : "alert-triangle"}
          size={16}
          color={granted ? theme.colors.emerald : theme.colors.amber}
        />
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      <Text style={styles.permissionNote}>{granted ? grantedNote : deniedNote}</Text>
      {granted ? null : (
        <PressableScale onPress={onFix} accessibilityRole="button" style={styles.fixButton}>
          <Text style={styles.fixButtonText}>Turn on</Text>
          <Feather name="chevron-right" size={14} color={theme.colors.amber} />
        </PressableScale>
      )}
    </View>
  );
}

function formatMb(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "—";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatBattery(level: number, state: Battery.BatteryState): string {
  if (level < 0) return "Unknown";
  const percent = `${Math.round(level * 100)}%`;
  return state === Battery.BatteryState.CHARGING ? `${percent} · Charging` : percent;
}

function formatNetwork(type: Network.NetworkStateType): string {
  switch (type) {
    case Network.NetworkStateType.WIFI:
      return "Wi-Fi";
    case Network.NetworkStateType.CELLULAR:
      return "Mobile data";
    case Network.NetworkStateType.ETHERNET:
      return "Ethernet";
    case Network.NetworkStateType.NONE:
      return "Offline";
    default:
      return "Unknown";
  }
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
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: minTouchTarget,
      paddingVertical: spacing.sm,
    },
    rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
    rowLabel: { ...typography.body, color: colors.foreground, flex: 1 },
    rowValue: { ...typography.subhead, color: colors.muted, maxWidth: "55%", textAlign: "right" },
    permission: { paddingVertical: spacing.md, gap: spacing.xs },
    permissionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    permissionNote: { ...typography.footnote, color: colors.muted, lineHeight: 18 },
    fixButton: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 2,
      marginTop: spacing.xs,
      paddingVertical: spacing.xs,
    },
    fixButtonText: { ...typography.subhead, color: colors.amber, fontWeight: "600" },
  });
}
