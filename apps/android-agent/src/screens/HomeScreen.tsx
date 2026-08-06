import * as Battery from "expo-battery";
import * as Network from "expo-network";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { PressableScale } from "../components/PressableScale";
import { useTheme, fontFamily } from "../theme";
import AemsUsage from "../../modules/aems-usage";
import type { AgentStatus } from "../state";

interface HomeScreenProps {
  status: AgentStatus;
}

interface DeviceReadout {
  todayFormatted: string;
  activeSeconds: number;
  batteryLevel: number;
  batteryState: Battery.BatteryState;
  networkType: Network.NetworkStateType;
  isConnected: boolean;
}

const EMPTY_READOUT: DeviceReadout = {
  todayFormatted: "0h 00m",
  activeSeconds: 0,
  batteryLevel: -1,
  batteryState: Battery.BatteryState.UNKNOWN,
  networkType: Network.NetworkStateType.UNKNOWN,
  isConnected: false,
};

export function HomeScreen({ status }: HomeScreenProps) {
  const theme = useTheme();
  const [hasUsageAccess, setHasUsageAccess] = useState(true);
  const [readout, setReadout] = useState<DeviceReadout>(EMPTY_READOUT);

  useEffect(() => {
    setHasUsageAccess(AemsUsage.hasUsageAccess());
  }, []);

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

  // Helper for computing initials
  const getInitials = (name?: string | null) => {
    if (!name) return "W";
    return name
      .split(" ")
      .map((part) => part[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  // Compute work progress percentage (8 hours = 28800 seconds target)
  const workTargetSeconds = 8 * 3600;
  const progressPercent = Math.min(100, Math.round((readout.activeSeconds / workTargetSeconds) * 100));

  // Determine battery icon
  const getBatteryIcon = () => {
    if (readout.batteryState === Battery.BatteryState.CHARGING) {
      return "battery-charging" as const;
    }
    if (readout.batteryLevel < 0.2) return "battery" as const; // low battery indicator styling via UI if needed
    return "battery" as const;
  };

  // Determine network icon & text
  const getNetworkDetails = () => {
    switch (readout.networkType) {
      case Network.NetworkStateType.WIFI:
        return { label: "Wi-Fi", icon: "wifi" as const };
      case Network.NetworkStateType.CELLULAR:
        return { label: "Cellular", icon: "phone" as const };
      case Network.NetworkStateType.ETHERNET:
        return { label: "Ethernet", icon: "hard-drive" as const };
      default:
        return readout.isConnected
          ? { label: "Connected", icon: "globe" as const }
          : { label: "Offline", icon: "wifi-off" as const };
    }
  };

  const networkDetails = getNetworkDetails();

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Header Profile Section */}
        <View style={styles.headerContainer}>
          <View style={styles.profileRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{getInitials(status.fullName)}</Text>
            </View>
            <View style={styles.headerInfo}>
              <Text style={styles.greeting}>{status.greeting}</Text>
              <Text style={styles.largeTitle}>{status.fullName ?? "Welcome"}</Text>
            </View>
          </View>
          <View style={[styles.statusBadge, status.collecting ? styles.badgeWorking : styles.badgePaused]}>
            <View style={[styles.badgeDot, status.collecting ? styles.dotWorking : styles.dotPaused]} />
            <Text style={status.collecting ? styles.badgeTextWorking : styles.badgeTextPaused}>
              {status.collecting ? "Collecting" : "Paused"}
            </Text>
          </View>
        </View>

        {/* Hero Card: Today's Work Progress */}
        <View style={[styles.heroCard, theme.shadow]}>
          <View style={styles.heroHeader}>
            <View>
              <Text style={styles.heroLabel}>TODAY'S ACTIVE TIME</Text>
              <Text style={styles.heroValue}>{readout.todayFormatted}</Text>
            </View>
            <View style={styles.heroIconBox}>
              <Feather name="clock" size={24} color={theme.colors.indigo} />
            </View>
          </View>

          {/* Progress Tracker bar */}
          <View style={styles.progressContainer}>
            <View style={styles.progressBarBackground}>
              <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
            </View>
            <View style={styles.progressLabels}>
              <Text style={styles.progressLabelText}>Daily Goal Progress</Text>
              <Text style={styles.progressPercentText}>{progressPercent}% of 8h</Text>
            </View>
          </View>
        </View>

        {/* Section: Activity & Sync */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>CONNECTION & SYNC</Text>
          <View style={[styles.card, theme.shadow]}>
            {/* Status Row */}
            <View style={styles.row}>
              <View style={styles.rowLabelBox}>
                <Feather name="play-circle" size={16} color={theme.colors.muted} />
                <Text style={styles.rowLabel}>Agent Status</Text>
              </View>
              <View style={styles.rowValueWrap}>
                <View
                  style={[
                    styles.indicatorDot,
                    { backgroundColor: status.collecting ? theme.colors.emerald : theme.colors.muted },
                  ]}
                />
                <Text style={styles.rowValue}>{status.collecting ? "Working" : "Paused"}</Text>
              </View>
            </View>

            <View style={styles.rowDivider} />

            {/* Sync Row */}
            <View style={styles.row}>
              <View style={styles.rowLabelBox}>
                <Feather name="refresh-cw" size={16} color={theme.colors.muted} />
                <Text style={styles.rowLabel}>Device Sync</Text>
              </View>
              <Text style={styles.rowValue}>{formatLastSync(status.lastSync)}</Text>
            </View>
          </View>
        </View>

        {/* Section: Device Stats */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>DEVICE HEALTH & COMPLIANCE</Text>
          <View style={[styles.card, theme.shadow]}>
            {/* Battery Row */}
            <View style={styles.row}>
              <View style={styles.rowLabelBox}>
                <Feather name={getBatteryIcon()} size={16} color={theme.colors.muted} />
                <Text style={styles.rowLabel}>Battery Level</Text>
              </View>
              <Text style={styles.rowValue}>{formatBattery(readout.batteryLevel, readout.batteryState)}</Text>
            </View>

            <View style={styles.rowDivider} />

            {/* Network Row */}
            <View style={styles.row}>
              <View style={styles.rowLabelBox}>
                <Feather name={networkDetails.icon} size={16} color={theme.colors.muted} />
                <Text style={styles.rowLabel}>Network Mode</Text>
              </View>
              <Text style={styles.rowValue}>{networkDetails.label}</Text>
            </View>

            <View style={styles.rowDivider} />

            {/* Policy Version Row */}
            <View style={styles.row}>
              <View style={styles.rowLabelBox}>
                <Feather name="file-text" size={16} color={theme.colors.muted} />
                <Text style={styles.rowLabel}>Company Policy</Text>
              </View>
              <Text style={styles.rowValue}>{status.policyVersion ?? "—"}</Text>
            </View>
          </View>
        </View>

        {!hasUsageAccess ? (
          <View style={[styles.noticeCard, theme.shadow]}>
            <View style={styles.noticeHeader}>
              <Feather name="alert-circle" size={20} color={theme.colors.amber} />
              <Text style={styles.noticeTitle}>Permission Required</Text>
            </View>
            <Text style={styles.noticeText}>
              Android requires usage access permission in settings to detect active applications and log time accurately.
            </Text>
            <PressableScale
              onPress={() => AemsUsage.requestUsageAccess()}
              accessibilityRole="button"
              style={styles.noticeButton}
            >
              <Text style={styles.noticeButtonText}>Enable Usage Access</Text>
              <Feather name="chevron-right" size={16} color={theme.colors.amber} />
            </PressableScale>
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
    activeSeconds: snapshot.screenActiveSeconds,
    batteryLevel,
    batteryState,
    networkType: networkState.type ?? Network.NetworkStateType.UNKNOWN,
    isConnected: !!networkState.isConnected,
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
    headerContainer: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: spacing.sm,
    },
    profileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
    },
    avatar: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: colors.indigo,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: {
      color: "#FFFFFF",
      fontFamily: fontFamily.bold,
      fontSize: 16,
      fontWeight: "700",
    },
    headerInfo: { gap: 1 },
    greeting: { ...typography.footnote, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
    largeTitle: { ...typography.title, color: colors.foreground },
    statusBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs / 2,
      borderRadius: 12,
      borderWidth: 1,
    },
    badgeWorking: {
      backgroundColor: theme.mode === "dark" ? "#064e3b" : "#ECFDF5",
      borderColor: colors.emerald,
    },
    badgePaused: {
      backgroundColor: theme.mode === "dark" ? "#1e293b" : "#F1F5F9",
      borderColor: colors.border,
    },
    badgeDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    dotWorking: { backgroundColor: colors.emerald },
    dotPaused: { backgroundColor: colors.muted },
    badgeTextWorking: {
      ...typography.caption,
      color: colors.emerald,
      fontWeight: "600",
    },
    badgeTextPaused: {
      ...typography.caption,
      color: colors.muted,
      fontWeight: "600",
    },
    heroCard: {
      padding: spacing.lg,
      borderRadius: radius,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      gap: spacing.md,
    },
    heroHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
    },
    heroLabel: { ...typography.caption, color: colors.muted, letterSpacing: 0.6, fontWeight: "600" },
    heroValue: { ...typography.largeTitle, color: colors.foreground, marginTop: 4 },
    heroIconBox: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: theme.mode === "dark" ? "#1E293B" : "#F1F5F9",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
    },
    progressContainer: { gap: spacing.xs, marginTop: spacing.xs },
    progressBarBackground: {
      height: 6,
      backgroundColor: theme.mode === "dark" ? "#1E293B" : "#E2E8F0",
      borderRadius: 3,
      overflow: "hidden",
    },
    progressBarFill: {
      height: "100%",
      backgroundColor: colors.indigo,
      borderRadius: 3,
    },
    progressLabels: {
      flexDirection: "row",
      justifyContent: "space-between",
    },
    progressLabelText: { ...typography.footnote, color: colors.muted },
    progressPercentText: { ...typography.footnote, color: colors.foreground, fontWeight: "600" },
    section: { gap: spacing.sm },
    sectionHeader: {
      ...typography.caption,
      color: colors.muted,
      marginLeft: spacing.xs,
      letterSpacing: 0.8,
      fontWeight: "600",
    },
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
    rowLabelBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    rowLabel: { ...typography.body, color: colors.foreground },
    rowValueWrap: { flexDirection: "row", alignItems: "center", gap: 7 },
    rowValue: { ...typography.subhead, color: colors.foreground, fontWeight: "500" },
    indicatorDot: { width: 7, height: 7, borderRadius: 4 },
    rowDivider: { height: 1, backgroundColor: colors.border },
    noticeCard: {
      backgroundColor: colors.card,
      borderColor: colors.amber,
      borderWidth: 1,
      borderRadius: radius,
      padding: spacing.md,
      gap: spacing.sm,
    },
    noticeHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
    },
    noticeTitle: {
      ...typography.headline,
      color: colors.foreground,
    },
    noticeText: {
      ...typography.footnote,
      color: colors.muted,
      lineHeight: 18,
    },
    noticeButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: theme.mode === "dark" ? "#422006" : "#FEF3C7",
      borderColor: colors.amber,
      borderWidth: 0.5,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius - 2,
    },
    noticeButtonText: {
      ...typography.subhead,
      color: theme.mode === "dark" ? "#F59E0B" : "#B45309",
      fontWeight: "600",
    },
  });
}

