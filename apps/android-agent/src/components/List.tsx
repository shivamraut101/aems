import { Feather } from "@expo/vector-icons";
import { Children, Fragment, isValidElement } from "react";
import { StyleSheet, Text, View } from "react-native";

import { PressableScale } from "./PressableScale";
import { useTheme } from "../theme";

/**
 * Grouped inset lists, the shape iOS Settings uses and the shape this app's content
 * already wanted to be: a quiet uppercase heading, a rounded card, rows separated by
 * hairlines that start at the label rather than at the card edge.
 *
 * That inset on the separator is the detail that does most of the work. A rule running
 * the full width chops a card into unrelated slabs; one that begins where the text
 * begins reads as *one* list with divisions in it, which is what these actually are.
 *
 * Built as primitives because four screens were each growing their own copy of this —
 * and three of them had already drifted apart on padding.
 */

export function ListSection({
  heading,
  footnote,
  children,
}: {
  heading?: string;
  footnote?: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);

  // Separators are drawn between children here rather than by each row, so a row never
  // has to know whether it happens to be last — which is exactly the thing that gets
  // forgotten when a list changes.
  const rows = Children.toArray(children).filter(isValidElement);

  return (
    <View style={styles.section}>
      {heading ? <Text style={styles.heading}>{heading}</Text> : null}
      <View style={styles.card}>
        {rows.map((row, index) => (
          <Fragment key={row.key ?? index}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footnote ? <Text style={styles.footnote}>{footnote}</Text> : null}
    </View>
  );
}

interface ListRowProps {
  icon?: React.ComponentProps<typeof Feather>["name"];
  iconColor?: string;
  label: string;
  value?: string;
  /** Secondary line under the label, for rows that need to explain themselves. */
  detail?: string;
  /** Present makes the row tappable and draws the chevron that advertises it. */
  onPress?: () => void;
  /** Right-hand accessory drawn instead of `value`. */
  accessory?: React.ReactNode;
}

export function ListRow({
  icon,
  iconColor,
  label,
  value,
  detail,
  onPress,
  accessory,
}: ListRowProps) {
  const theme = useTheme();
  const styles = createStyles(theme);

  const body = (
    // A row with a detail line is top-aligned, not centred. Centring puts the icon
    // level with the *description* rather than the thing it labels, which on a
    // three-line row leaves it floating in the middle of a paragraph.
    <View style={[styles.row, detail ? styles.rowTopAligned : null]}>
      {icon ? (
        <Feather
          name={icon}
          size={17}
          color={iconColor ?? theme.colors.muted}
          style={[styles.icon, detail ? styles.iconTopAligned : null]}
        />
      ) : null}

      <View style={styles.labelBlock}>
        <Text style={styles.label}>{label}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>

      {accessory ?? (value ? <Text style={styles.value} numberOfLines={1}>{value}</Text> : null)}

      {/* A chevron is a promise that tapping does something; it appears only when it does. */}
      {onPress ? (
        <Feather name="chevron-right" size={18} color={theme.colors.muted} style={styles.chevron} />
      ) : null}
    </View>
  );

  if (!onPress) return body;

  return (
    <PressableScale onPress={onPress} scaleTo={0.985} accessibilityRole="button">
      {body}
    </PressableScale>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing, typography, radius, minTouchTarget } = theme;

  return StyleSheet.create({
    section: { gap: spacing.sm },
    heading: {
      ...typography.caption,
      color: colors.muted,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      marginLeft: spacing.md,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: radius + 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    },
    // Inset from the left so it starts under the label, not under the icon — the
    // detail that makes a group read as one list.
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginLeft: spacing.md + 17 + spacing.sm,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: minTouchTarget,
      paddingVertical: spacing.sm + 2,
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
    },
    rowTopAligned: { alignItems: "flex-start" },
    icon: { width: 17 },
    // Nudged down to sit on the label's cap height rather than its line box, which is
    // where the eye expects it — a glyph aligned to the top of the line reads high.
    iconTopAligned: { marginTop: 3 },
    labelBlock: { flex: 1, minWidth: 0, gap: 1 },
    label: { ...typography.body, color: colors.foreground },
    detail: { ...typography.footnote, color: colors.muted, lineHeight: 18 },
    value: { ...typography.body, color: colors.muted, maxWidth: "48%", textAlign: "right" },
    chevron: { marginLeft: -2, marginRight: -4 },
    footnote: {
      ...typography.footnote,
      color: colors.muted,
      marginLeft: spacing.md,
      marginTop: -spacing.xs,
      lineHeight: 18,
    },
  });
}
