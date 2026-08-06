import { Feather } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import AemsUsage from "../../modules/aems-usage";
import { ListRow, ListSection } from "../components/List";
import { PressableScale } from "../components/PressableScale";
import { Screen } from "../components/Screen";
import type { DayTotals } from "../day";
import type { AgentStatus } from "../state";
import { useTheme } from "../theme";

interface HomeScreenProps {
  status: AgentStatus;
  onStartBreak: () => Promise<void>;
  onEndBreak: () => Promise<void>;
  onStartDay: () => Promise<void>;
  onEndDay: () => Promise<void>;
}

/** The daily target the progress bar is drawn against. */
const WORK_TARGET_SECONDS = 8 * 3600;

export function HomeScreen({
  status,
  onStartBreak,
  onEndBreak,
  onStartDay,
  onEndDay,
}: HomeScreenProps) {
  const theme = useTheme();
  const styles = createStyles(theme);

  const [hasUsageAccess, setHasUsageAccess] = useState(true);
  const [busy, setBusy] = useState<"break" | "day" | null>(null);

  useEffect(() => {
    setHasUsageAccess(AemsUsage.hasUsageAccess());
  }, []);

  const totals = useLiveTotals(status);
  const split = splitForDisplay(totals);
  const progressPercent = Math.min(
    100,
    Math.round((totals.activeSeconds / WORK_TARGET_SECONDS) * 100),
  );

  async function run(kind: "break" | "day", action: () => Promise<void>) {
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }

  const statusLabel = status.revoked
    ? "Stopped"
    : status.dayEnded
      ? "Finished"
      : status.onBreak
        ? "On a break"
        : status.collecting
          ? "Collecting"
          : "Paused";
  const statusIsLive = status.collecting && !status.onBreak && !status.dayEnded;

  return (
    <Screen
      title={status.fullName ?? "Welcome"}
      subtitle={status.greeting}
      accessory={
        <View style={[styles.statusBadge, statusIsLive ? styles.badgeWorking : styles.badgePaused]}>
          <View style={[styles.badgeDot, statusIsLive ? styles.dotWorking : styles.dotPaused]} />
          <Text style={statusIsLive ? styles.badgeTextWorking : styles.badgeTextPaused}>
            {statusLabel}
          </Text>
        </View>
      }
    >
      {status.dayEnded ? (
        <Banner
          theme={theme}
          icon="check-circle"
          title="You have finished for today"
          body="Nothing further is being recorded. Start again below whenever you carry on."
        />
      ) : status.onBreak ? (
        <Banner
          theme={theme}
          icon="pause-circle"
          title="You are on a break"
          body="App usage and working time are not being recorded until you end the break."
        />
      ) : null}

      {/* Hero: today's work */}
      <View style={styles.heroCard}>
        <View style={styles.heroHeader}>
          <View>
            <Text style={styles.heroLabel}>TODAY&rsquo;S ACTIVE TIME</Text>
            <Text style={styles.heroValue}>{formatDuration(totals.activeSeconds)}</Text>
          </View>
          <View style={styles.heroIconBox}>
            <Feather name="clock" size={24} color={theme.colors.indigo} />
          </View>
        </View>

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

      {/*
        The four-way split `docs/scope.md` §2.2 is written around. Shown as durations
        rather than as one percentage, per `docs/design.md`: "Focused time 7h 20m"
        reads as insight, "86%" reads as a score.
      */}
      <View style={styles.section}>
        <Text style={styles.sectionHeader}>YOUR DAY</Text>
        <View style={styles.splitCard}>
          <Split theme={theme} label="Total" value={split.total} tone="foreground" />
          <Split theme={theme} label="Active" value={split.active} tone="emerald" />
          <Split theme={theme} label="Idle" value={split.idle} tone="muted" />
          <Split theme={theme} label="Break" value={split.breakTime} tone="amber" />
        </View>
      </View>

      {/* Controls */}
      {!status.revoked ? (
        <View style={styles.controls}>
          {status.dayStarted && !status.dayEnded ? (
            <PressableScale
              onPress={() => void run("break", status.onBreak ? onEndBreak : onStartBreak)}
              disabled={busy !== null}
              accessibilityRole="button"
              style={[styles.secondaryButton, busy !== null && styles.buttonDisabled]}
            >
              {busy === "break" ? (
                <ActivityIndicator size="small" color={theme.colors.foreground} />
              ) : (
                <>
                  <Feather
                    name={status.onBreak ? "play" : "pause"}
                    size={16}
                    color={theme.colors.foreground}
                  />
                  <Text style={styles.secondaryButtonText}>
                    {status.onBreak ? "End break" : "Take a break"}
                  </Text>
                </>
              )}
            </PressableScale>
          ) : null}

          <PressableScale
            onPress={() =>
              void run("day", status.dayStarted && !status.dayEnded ? onEndDay : onStartDay)
            }
            disabled={busy !== null}
            accessibilityRole="button"
            style={[styles.primaryButton, busy !== null && styles.buttonDisabled]}
          >
            {busy === "day" ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <Feather
                  name={status.dayStarted && !status.dayEnded ? "log-out" : "log-in"}
                  size={16}
                  color="#FFFFFF"
                />
                <Text style={styles.primaryButtonText}>
                  {status.dayStarted && !status.dayEnded ? "End day" : "Start working"}
                </Text>
              </>
            )}
          </PressableScale>
        </View>
      ) : null}

      <ListSection heading="Connection & sync">
        <ListRow
          icon="play-circle"
          label="Agent status"
          accessory={
            <View style={styles.rowValueWrap}>
              <View
                style={[
                  styles.indicatorDot,
                  { backgroundColor: statusIsLive ? theme.colors.emerald : theme.colors.muted },
                ]}
              />
              <Text style={styles.rowValue}>{statusIsLive ? "Working" : "Paused"}</Text>
            </View>
          }
        />
        <ListRow icon="refresh-cw" label="Device sync" value={formatLastSync(status.lastSync)} />
        {/*
          Shown only when there is something waiting. A permanent "0 events" row would
          train the reader to ignore the one number that matters when the phone has
          been offline.
        */}
        {status.pendingEvents > 0 ? (
          <ListRow
            icon="upload-cloud"
            label="Waiting to sync"
            value={`${status.pendingEvents} ${status.pendingEvents === 1 ? "event" : "events"}`}
          />
        ) : null}
      </ListSection>

      {!hasUsageAccess ? (
        <ListSection heading="Action needed">
          <ListRow
            icon="alert-circle"
            iconColor={theme.colors.amber}
            label="Enable usage access"
            detail="Android requires usage access to detect active applications and log time accurately."
            onPress={() => AemsUsage.requestUsageAccess()}
          />
        </ListSection>
      ) : null}
    </Screen>
  );
}

/**
 * The stored totals, carried forward a second at a time.
 *
 * `refresh()` recomputes them once a sync cycle, which is far too slow for a figure
 * with a seconds digit on it — so the gap since the last read is added here and the
 * next read snaps back to native truth. Which counter grows depends on what the
 * employee is doing: a break advances `break`, working advances `active`, and `total`
 * advances through both, which keeps the partition adding up between reads exactly as
 * it does inside `summariseDay`.
 */
function useLiveTotals(status: AgentStatus): DayTotals {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [readAtMs, setReadAtMs] = useState(() => Date.now());

  useEffect(() => setReadAtMs(Date.now()), [status.totals]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const running = status.dayStarted && !status.dayEnded && !status.revoked;
  if (!running) return status.totals;

  const elapsed = Math.max(0, Math.floor((nowMs - readAtMs) / 1000));

  return {
    totalSeconds: status.totals.totalSeconds + elapsed,
    activeSeconds: status.totals.activeSeconds + (status.onBreak ? 0 : elapsed),
    breakSeconds: status.totals.breakSeconds + (status.onBreak ? elapsed : 0),
    idleSeconds: status.totals.idleSeconds,
  };
}

function Banner({
  theme,
  icon,
  title,
  body,
}: {
  theme: ReturnType<typeof useTheme>;
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  body: string;
}) {
  const styles = createStyles(theme);
  return (
    <View style={styles.banner}>
      <Feather name={icon} size={18} color={theme.colors.amber} />
      <View style={styles.bannerText}>
        <Text style={styles.bannerTitle}>{title}</Text>
        <Text style={styles.bannerBody}>{body}</Text>
      </View>
    </View>
  );
}

function Split({
  theme,
  label,
  value,
  tone,
}: {
  theme: ReturnType<typeof useTheme>;
  label: string;
  value: string;
  tone: "foreground" | "emerald" | "muted" | "amber";
}) {
  const styles = createStyles(theme);
  const color =
    tone === "emerald"
      ? theme.colors.emerald
      : tone === "amber"
        ? theme.colors.amber
        : tone === "muted"
          ? theme.colors.muted
          : theme.colors.foreground;

  return (
    <View style={styles.split}>
      <Text style={[styles.splitValue, { color }]}>{value}</Text>
      <Text style={styles.splitLabel}>{label}</Text>
    </View>
  );
}

/**
 * `0h 03m 45s`. Minutes and seconds are zero-padded so the readout keeps a constant
 * width — an unpadded value shifts the whole line every time it crosses ten, which on
 * a figure that updates every second is a visible twitch rather than a detail.
 */
function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * The four figures, rounded so they still add up.
 *
 * Rounding each part on its own is what produced "Total 6m" sitting above
 * "1m + 0m + 4m": every part loses up to a minute to the floor, and the reader is left
 * looking at arithmetic that does not work — on a screen about how their time was
 * counted, which is the worst possible place to look approximate.
 *
 * Allocating from running sums hands each part the difference between two cumulative
 * roundings, so the error moves between neighbours instead of accumulating and the
 * three parts always total the whole. It is the same trick the desktop agent's
 * `summariseDay` uses, for the same reason.
 */
function splitForDisplay(totals: DayTotals): {
  total: string;
  active: string;
  idle: string;
  breakTime: string;
} {
  const toMinutes = (seconds: number) => Math.round(Math.max(0, seconds) / 60);

  const activeMinutes = toMinutes(totals.activeSeconds);
  const throughIdle = toMinutes(totals.activeSeconds + totals.idleSeconds);
  const throughBreak = toMinutes(
    totals.activeSeconds + totals.idleSeconds + totals.breakSeconds,
  );

  const idleMinutes = throughIdle - activeMinutes;
  const breakMinutes = throughBreak - throughIdle;

  return {
    // Deliberately the sum of the parts rather than a fourth independent rounding of
    // `totalSeconds`, so the row can never contradict itself.
    total: formatMinutes(activeMinutes + idleMinutes + breakMinutes),
    active: formatMinutes(activeMinutes),
    idle: formatMinutes(idleMinutes),
    breakTime: formatMinutes(breakMinutes),
  };
}

/** `7h 20m` — the split reads as a comparison, and seconds there would be noise. */
function formatMinutes(totalMinutes: number): string {
  const safe = Math.max(0, totalMinutes);
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes).padStart(2, "0")}m`;
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
    content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl },

    headerContainer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
    profileRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1, minWidth: 0 },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.indigo,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: { ...typography.headline, color: "#FFFFFF" },
    headerInfo: { flex: 1, minWidth: 0 },
    greeting: { ...typography.caption, color: colors.muted, letterSpacing: 0.6, textTransform: "uppercase" },
    largeTitle: { ...typography.title, color: colors.foreground },

    statusBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
    },
    badgeWorking: { borderColor: colors.emerald, backgroundColor: "transparent" },
    badgePaused: { borderColor: colors.border, backgroundColor: "transparent" },
    badgeDot: { width: 7, height: 7, borderRadius: 4 },
    dotWorking: { backgroundColor: colors.emerald },
    dotPaused: { backgroundColor: colors.muted },
    badgeTextWorking: { ...typography.caption, color: colors.emerald, fontWeight: "600" },
    badgeTextPaused: { ...typography.caption, color: colors.muted, fontWeight: "600" },

    banner: {
      flexDirection: "row",
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius,
      borderWidth: 1,
      borderColor: colors.amber,
      backgroundColor: colors.warningSurface,
    },
    bannerText: { flex: 1, gap: 2 },
    bannerTitle: { ...typography.subhead, color: colors.foreground },
    bannerBody: { ...typography.footnote, color: colors.foreground, lineHeight: 18 },

    heroCard: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      padding: spacing.md,
      gap: spacing.md,
    },
    heroHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
    heroLabel: { ...typography.caption, color: colors.muted, letterSpacing: 0.6, fontWeight: "600" },
    heroValue: { ...typography.largeTitle, color: colors.foreground, marginTop: 4 },
    heroIconBox: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: theme.mode === "dark" ? "#1E293B" : "#F1F5F9",
      alignItems: "center",
      justifyContent: "center",
    },
    progressContainer: { gap: spacing.xs },
    progressBarBackground: { height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: "hidden" },
    progressBarFill: { height: 6, borderRadius: 3, backgroundColor: colors.indigo },
    progressLabels: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    progressLabelText: { ...typography.footnote, color: colors.muted },
    progressPercentText: { ...typography.footnote, color: colors.foreground, fontWeight: "600" },

    section: { gap: spacing.sm },
    sectionHeader: { ...typography.caption, color: colors.muted, letterSpacing: 0.6, marginLeft: spacing.xs },

    splitCard: {
      flexDirection: "row",
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      paddingVertical: spacing.md,
    },
    split: { flex: 1, alignItems: "center", gap: 2 },
    splitValue: { ...typography.headline },
    splitLabel: { ...typography.caption, color: colors.muted },

    controls: { flexDirection: "row", gap: spacing.sm },
    primaryButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.xs,
      minHeight: minTouchTarget,
      borderRadius: radius,
      backgroundColor: colors.indigo,
      ...theme.shadow,
    },
    primaryButtonText: { ...typography.headline, color: "#FFFFFF" },
    secondaryButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.xs,
      minHeight: minTouchTarget,
      borderRadius: radius,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    secondaryButtonText: { ...typography.headline, color: colors.foreground },
    buttonDisabled: { opacity: 0.5 },

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
      justifyContent: "space-between",
      minHeight: minTouchTarget,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    rowDivider: { height: 1, backgroundColor: colors.border },
    rowLabelBox: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1, minWidth: 0 },
    rowLabel: { ...typography.body, color: colors.foreground },
    rowValueWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
    rowValue: { ...typography.subhead, color: colors.muted },
    indicatorDot: { width: 8, height: 8, borderRadius: 4 },

    noticeCard: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.amber,
      borderRadius: radius,
      padding: spacing.md,
      gap: spacing.sm,
    },
    noticeHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    noticeTitle: { ...typography.headline, color: colors.foreground },
    noticeText: { ...typography.footnote, color: colors.muted, lineHeight: 18 },
    noticeButton: { flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", paddingVertical: spacing.xs },
    noticeButtonText: { ...typography.subhead, color: colors.amber, fontWeight: "600" },
  });
}
