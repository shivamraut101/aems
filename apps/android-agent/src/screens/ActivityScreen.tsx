import { Feather } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import AemsUsage, { type AppUsageRecord } from "../../modules/aems-usage";
import { ListSection } from "../components/List";
import { Screen } from "../components/Screen";
import { useTheme } from "../theme";

/**
 * The employee's own app usage for today — `docs/scope.md` §3.2, and the half of
 * Non-negotiable #3 ("employees can read their own data") the phone was missing.
 *
 * The agent already collected every figure here and sent it to the company; until now
 * the person it was collected *from* was the only party who could not see it. Reading
 * it back through the same `queryUsage` call the sync cycle uses means what the
 * employee sees is what was reported, not a second and kinder computation.
 */

/** Anything shorter than this is noise — a launcher redraw, a notification tap. */
const MIN_VISIBLE_MS = 60_000;

export function ActivityScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);

  const [records, setRecords] = useState<AppUsageRecord[] | null>(null);
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
      setRecords(
        stats
          .filter((stat) => stat.totalTimeForegroundMs >= MIN_VISIBLE_MS)
          .sort((a, b) => b.totalTimeForegroundMs - a.totalTimeForegroundMs),
      );
    } catch {
      setRecords([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const total = (records ?? []).reduce((sum, r) => sum + r.totalTimeForegroundMs, 0);
  const longest = records?.[0]?.totalTimeForegroundMs ?? 0;

  return (
    <Screen
      title="Your activity"
      subtitle="App usage recorded on this phone today. This is exactly what is reported to your company."
      onRefresh={load}
    >
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

          <ListSection heading="By app">
            {records.map((record) => (
              <View key={record.packageName} style={styles.appRow}>
                <View style={styles.appHeader}>
                  <Text style={styles.appName} numberOfLines={1}>
                    {record.appLabel}
                  </Text>
                  <Text style={styles.appTime}>{formatSpan(record.totalTimeForegroundMs)}</Text>
                </View>
                {/*
                  Bars scale against the longest entry, not the total. Against the
                  total, a normal day of ten apps renders as ten near-invisible
                  slivers; against the longest, the comparison the reader actually
                  wants — how this app relates to the biggest one — is the one drawn.
                */}
                <View style={styles.barTrack}>
                  <View
                    style={[
                      styles.barFill,
                      {
                        width: `${longest > 0 ? (record.totalTimeForegroundMs / longest) * 100 : 0}%`,
                      },
                    ]}
                  />
                </View>
              </View>
            ))}
          </ListSection>
        </>
      )}
    </Screen>
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
    loading: { marginTop: spacing.xl },
    summaryCard: {
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius + 4,
      padding: spacing.md,
      gap: 2,
    },
    summaryLabel: { ...typography.caption, color: colors.muted, letterSpacing: 0.6 },
    summaryValue: { ...typography.largeTitle, color: colors.foreground },
    summaryFootnote: { ...typography.footnote, color: colors.muted },
    appRow: { paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md, gap: spacing.sm },
    appHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    appName: { ...typography.body, color: colors.foreground, flex: 1 },
    appTime: { ...typography.subhead, color: colors.muted },
    barTrack: { height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: "hidden" },
    barFill: { height: 4, borderRadius: 2, backgroundColor: colors.indigo },
    notice: {
      flexDirection: "row",
      gap: spacing.sm,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius + 4,
      padding: spacing.md,
    },
    noticeText: { flex: 1, gap: 2 },
    noticeTitle: { ...typography.subhead, color: colors.foreground },
    noticeBody: { ...typography.footnote, color: colors.muted, lineHeight: 18 },
  });
}
