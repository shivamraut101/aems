import { Feather } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import AemsUsage, { type AppUsageRecord } from "../../modules/aems-usage";
import { useTheme } from "../theme";

/**
 * The employee's own app usage for today — `docs/scope.md` §3.2, and the half of
 * Non-negotiable #3 ("employees can read their own data") that the phone was missing.
 *
 * The agent already collected every figure on this screen and sent it to the company;
 * until now the person it was collected *from* was the only party who could not see
 * it. Reading it back from the same `queryUsage` call the sync cycle uses means what
 * the employee sees is what was reported, rather than a second, kinder computation.
 */

/** Anything shorter than this is noise — a launcher redraw, a notification tap. */
const MIN_VISIBLE_MS = 60_000;

export function ActivityScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);

  const [records, setRecords] = useState<AppUsageRecord[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    if (!AemsUsage.hasUsageAccess()) {
      setDenied(true);
      setRecords([]);
      return;
    }

    setDenied(false);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    try {
      const stats = await AemsUsage.queryUsage(startOfDay.getTime(), Date.now());
      const visible = stats
        .filter((stat) => stat.totalTimeForegroundMs >= MIN_VISIBLE_MS)
        .sort((a, b) => b.totalTimeForegroundMs - a.totalTimeForegroundMs);
      setRecords(visible);
    } catch {
      setRecords([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const total = (records ?? []).reduce((sum, r) => sum + r.totalTimeForegroundMs, 0);
  const longest = records?.[0]?.totalTimeForegroundMs ?? 0;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.muted} />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>Your activity</Text>
          <Text style={styles.subtitle}>
            App usage recorded on this phone today. This is exactly what is reported to
            your company.
          </Text>
        </View>

        {records === null ? (
          <ActivityIndicator style={styles.loading} color={theme.colors.indigo} />
        ) : denied ? (
          <Notice
            theme={theme}
            icon="alert-triangle"
            title="Usage access is turned off"
            body="Android is blocking app usage details, so nothing can be shown or recorded here. You can turn it back on from the Device tab."
          />
        ) : records.length === 0 ? (
          <Notice
            theme={theme}
            icon="inbox"
            title="Nothing recorded yet"
            body="Apps you use for a minute or more will appear here."
          />
        ) : (
          <>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>TOTAL APP TIME TODAY</Text>
              <Text style={styles.summaryValue}>{formatSpan(total)}</Text>
              <Text style={styles.summaryFootnote}>
                Across {records.length} {records.length === 1 ? "app" : "apps"}
              </Text>
            </View>

            <View style={styles.list}>
              {records.map((record, index) => (
                <View key={record.packageName}>
                  {index > 0 ? <View style={styles.divider} /> : null}
                  <View style={styles.row}>
                    <View style={styles.rowHeader}>
                      <Text style={styles.appName} numberOfLines={1}>
                        {record.appLabel}
                      </Text>
                      <Text style={styles.appTime}>{formatSpan(record.totalTimeForegroundMs)}</Text>
                    </View>
                    {/*
                      Bars are scaled against the longest entry rather than the total.
                      Against the total, a normal day of ten apps renders as ten
                      near-invisible slivers; against the longest, the comparison the
                      reader actually wants — how this app relates to the biggest one —
                      is the one the bar shows.
                    */}
                    <View style={styles.barTrack}>
                      <View
                        style={[
                          styles.barFill,
                          { width: `${longest > 0 ? (record.totalTimeForegroundMs / longest) * 100 : 0}%` },
                        ]}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Notice({
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
    <View style={styles.notice}>
      <Feather name={icon} size={18} color={theme.colors.muted} />
      <View style={styles.noticeText}>
        <Text style={styles.noticeTitle}>{title}</Text>
        <Text style={styles.noticeBody}>{body}</Text>
      </View>
    </View>
  );
}

/** "2h 05m" / "45m" — minutes are the smallest unit worth showing for a day's usage. */
function formatSpan(totalMs: number): string {
  const minutes = Math.floor(totalMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  if (hours === 0) return `${remainder}m`;
  return `${hours}h ${String(remainder).padStart(2, "0")}m`;
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography, radius } = theme;

  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl },
    header: { gap: spacing.xs },
    title: { ...typography.title, color: colors.foreground },
    subtitle: { ...typography.footnote, color: colors.muted, lineHeight: 19 },
    loading: { marginTop: spacing.xl },
    summaryCard: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      padding: spacing.md,
      gap: 2,
    },
    summaryLabel: { ...typography.caption, color: colors.muted, letterSpacing: 0.6 },
    summaryValue: { ...typography.largeTitle, color: colors.foreground },
    summaryFootnote: { ...typography.footnote, color: colors.muted },
    list: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      paddingHorizontal: spacing.md,
    },
    divider: { height: 1, backgroundColor: colors.border },
    row: { paddingVertical: spacing.md, gap: spacing.sm },
    rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
    appName: { ...typography.body, color: colors.foreground, flex: 1 },
    appTime: { ...typography.subhead, color: colors.muted },
    barTrack: { height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: "hidden" },
    barFill: { height: 4, borderRadius: 2, backgroundColor: colors.indigo },
    notice: {
      flexDirection: "row",
      gap: spacing.sm,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius,
      padding: spacing.md,
    },
    noticeText: { flex: 1, gap: 2 },
    noticeTitle: { ...typography.subhead, color: colors.foreground },
    noticeBody: { ...typography.footnote, color: colors.muted, lineHeight: 18 },
  });
}
