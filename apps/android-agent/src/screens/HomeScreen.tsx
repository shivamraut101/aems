import * as Battery from "expo-battery";
import * as Network from "expo-network";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import AemsUsage from "../../modules/aems-usage";
import { colors, spacing } from "../theme";
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

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.greeting}>{status.greeting}</Text>
        <Text style={styles.name}>{status.fullName ?? "Welcome"}</Text>

        <View style={styles.hero}>
          <Text style={styles.heroLabel}>Today&rsquo;s work</Text>
          <Text style={styles.heroValue}>{readout.todayFormatted}</Text>
        </View>

        <View style={styles.rows}>
          <Row label="Status" value={status.collecting ? "Working" : "Paused"} tone={status.collecting ? "on" : "off"} />
          <Row label="Battery" value={readout.batteryLabel} />
          <Row label="Network" value={readout.networkLabel} />
          <Row label="Device sync" value={formatLastSync(status.lastSync)} />
          <Row label="Company policy" value={status.policyVersion ?? "—"} />
        </View>

        {!hasUsageAccess ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>Usage access needed</Text>
            <Text style={styles.noticeBody}>
              Android requires you to grant usage access in system settings before app
              activity can be recorded.
            </Text>
            <Text style={styles.link} onPress={() => AemsUsage.requestUsageAccess()}>
              Open settings
            </Text>
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

function Row({ label, value, tone }: { label: string; value: string; tone?: "on" | "off" }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValueWrap}>
        {tone ? (
          <View style={[styles.dot, { backgroundColor: tone === "on" ? colors.emerald : colors.muted }]} />
        ) : null}
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  greeting: { color: colors.muted, fontSize: 15 },
  name: { color: colors.foreground, fontSize: 24, fontWeight: "600", marginTop: -6 },
  hero: {
    marginTop: spacing.sm,
    padding: spacing.lg,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroLabel: { color: colors.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6 },
  heroValue: { color: colors.foreground, fontSize: 34, fontWeight: "700", marginTop: 4 },
  rows: { borderRadius: 8, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLabel: { color: colors.muted, fontSize: 14 },
  rowValueWrap: { flexDirection: "row", alignItems: "center", gap: 7 },
  rowValue: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  dot: { width: 7, height: 7, borderRadius: 4 },
  notice: {
    padding: spacing.md,
    borderRadius: 8,
    backgroundColor: colors.warningSurface,
    gap: 6,
  },
  noticeTitle: { color: colors.foreground, fontWeight: "600" },
  noticeBody: { color: colors.muted, lineHeight: 20 },
  link: { color: colors.indigo, fontWeight: "600", marginTop: 2 },
});
