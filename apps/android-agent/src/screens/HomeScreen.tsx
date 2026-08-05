import * as Battery from "expo-battery";
import * as Network from "expo-network";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PressableScale } from "../components/PressableScale";
import { useTheme } from "../theme";
import AemsUsage from "../../modules/aems-usage";
import type { AgentStatus } from "../state";

interface HomeScreenProps {
  status: AgentStatus;
}

interface DeviceReadout {
  todayFormatted: string;
  batteryLabel: string;
  networkLabel: string;
}

const EMPTY_READOUT: DeviceReadout = {
  todayFormatted: "0h 00m",
  batteryLabel: "—",
  networkLabel: "—",
};

/**
 * Home screen — the "Company Work Companion" per docs/design.md.
 *
 * Framed around what the employee gets out of it (their own hours, their own sync
 * status), not around what is being collected from them. The consent screen already
 * covers the latter in full; repeating it here would just be nagging.
 */
export function HomeScreen({ status }: HomeScreenProps) {
  const theme = useTheme();
  const [hasUsageAccess, setHasUsageAccess] = useState(true);
  const [readout, setReadout] = useState<DeviceReadout>(EMPTY_READOUT);

  useEffect(() => {
    setHasUsageAccess(AemsUsage.hasUsageAccess());
  }, []);

  // Re-read on mount and again after every sync cycle (`status.lastSync` changes
  // each time one completes) rather than on its own timer — battery/network/screen
  // time drift is only interesting in step with the data the agent actually sends.
  useEffect(() => {
    let cancelled = false;

    void loadReadout().then((next) => {
      if (!cancelled) setReadout(next);
    });

    return () => {
      cancelled = true;
    };
  }, [status.lastSync]);

  const styles = createStyles(theme);
  const rows: Array<{ label: string; value: string; tone?: "on" | "off" }> = [
    { label: "Status", value: status.collecting ? "Working" : "Paused", tone: status.collecting ? "on" : "off" },
    { label: "Battery", value: readout.batteryLabel },
    { label: "Network", value: readout.networkLabel },
    { label: "Device sync", value: formatLastSync(status.lastSync) },
    { label: "Company policy", value: status.policyVersion ?? "—" },
  ];

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleBlock}>
          <Text style={styles.greeting}>{status.greeting}</Text>
          <Text style={styles.largeTitle}>{status.fullName ?? "Welcome"}</Text>
        </View>

        <View style={[styles.hero, theme.shadow]}>
          <Text style={styles.heroLabel}>TODAY&rsquo;S WORK</Text>
          <Text style={styles.heroValue}>{readout.todayFormatted}</Text>
        </View>

        <View style={[styles.card, theme.shadow]}>
          {rows.map((row, index) => (
            <View key={row.label} style={[styles.row, index < rows.length - 1 && styles.rowDivider]}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <View style={styles.rowValueWrap}>
                {row.tone ? (
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: row.tone === "on" ? theme.colors.emerald : theme.colors.muted },
                    ]}
                  />
                ) : null}
                <Text style={styles.rowValue}>{row.value}</Text>
              </View>
            </View>
          ))}
        </View>

        {!hasUsageAccess ? (
          <View style={[styles.notice, theme.shadow]}>
            <View style={styles.noticeAccent} />
            <View style={styles.noticeBody}>
              <Text style={styles.noticeTitle}>Usage access needed</Text>
              <Text style={styles.noticeText}>
                Android requires you to grant usage access in system settings before
                app activity can be recorded.
              </Text>
              <PressableScale
                onPress={() => AemsUsage.requestUsageAccess()}
                accessibilityRole="button"
                style={styles.linkTouchArea}
              >
                <Text style={styles.link}>Open settings</Text>
              </PressableScale>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

async function loadReadout(): Promise<DeviceReadout> {
  const [batteryLevel, batteryState, networkState, snapshot] = await Promise.all([
    Battery.getBatteryLevelAsync(),
    Battery.getBatteryStateAsync(),
    Network.getNetworkStateAsync(),
    AemsUsage.getDeviceSnapshot(),
  ]);

  return {
    todayFormatted: formatHoursMinutes(snapshot.screenActiveSeconds),
    batteryLabel: formatBattery(batteryLevel, batteryState),
    networkLabel: formatNetwork(networkState),
  };
}

function formatHoursMinutes(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatBattery(level: number, state: Battery.BatteryState): string {
  if (level < 0) return "Unknown";
  const percent = `${Math.round(level * 100)}%`;
  return state === Battery.BatteryState.CHARGING ? `${percent} · Charging` : percent;
}

function formatNetwork(state: Network.NetworkState): string {
  if (state.type === Network.NetworkStateType.WIFI) return "Wi-Fi";
  if (state.type === Network.NetworkStateType.CELLULAR) return "Cellular";
  if (state.type === Network.NetworkStateType.ETHERNET) return "Ethernet";
  if (state.type === Network.NetworkStateType.NONE) return "Offline";
  return state.isConnected ? "Connected" : "Offline";
}

function formatLastSync(lastSync: string): string {
  if (lastSync === "Not synced") return lastSync;

  const then = new Date(lastSync).getTime();
  if (Number.isNaN(then)) return "Not synced";

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (elapsedSeconds < 60) return "Just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography, radius, minTouchTarget } = theme;

  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, paddingTop: spacing.md, gap: spacing.lg },
    titleBlock: { gap: 2 },
    greeting: { ...typography.subhead, color: colors.muted },
    largeTitle: { ...typography.largeTitle, color: colors.foreground },
    hero: {
      padding: spacing.lg,
      borderRadius: radius,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
    },
    heroLabel: { ...typography.caption, color: colors.muted, letterSpacing: 0.6 },
    heroValue: { ...typography.largeTitle, color: colors.foreground, marginTop: 4 },
    card: {
      borderRadius: radius,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      minHeight: minTouchTarget,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    rowLabel: { ...typography.callout, color: colors.muted },
    rowValueWrap: { flexDirection: "row", alignItems: "center", gap: 7 },
    rowValue: { ...typography.subhead, color: colors.foreground },
    dot: { width: 7, height: 7, borderRadius: 4 },
    notice: {
      flexDirection: "row",
      borderRadius: radius,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: "hidden",
    },
    noticeAccent: { width: 3, backgroundColor: colors.amber },
    noticeBody: { flex: 1, padding: spacing.md, gap: spacing.xs },
    noticeTitle: { ...typography.headline, color: colors.foreground },
    noticeText: { ...typography.footnote, color: colors.muted },
    linkTouchArea: { minHeight: minTouchTarget, justifyContent: "center", marginLeft: -spacing.xs },
    link: { ...typography.subhead, color: colors.indigo, paddingHorizontal: spacing.xs },
  });
}
