import * as Battery from "expo-battery";
import * as Network from "expo-network";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";

import AemsUsage, { type DeviceSnapshot } from "../../modules/aems-usage";
import { ListRow, ListSection } from "../components/List";
import { Screen } from "../components/Screen";
import { checkLocationAccess, requestLocationAccess, type LocationAccess } from "../location";
import { useTheme } from "../theme";

/**
 * The device inventory `docs/scope.md` §3.4 specifies, plus the permissions the agent
 * depends on.
 *
 * Both halves answer one question — "what does this phone tell my employer about
 * itself, and what is it allowed to see?" — so they belong together rather than split
 * across an inventory page and a settings page.
 *
 * The permission rows follow the desktop agent's pattern: name the gap plainly, say
 * what stops working because of it, and offer the one control that fixes it.
 */

interface Readout {
  snapshot: DeviceSnapshot | null;
  batteryLevel: number;
  batteryState: Battery.BatteryState;
  network: Network.NetworkStateType;
  usageAccess: boolean;
  notificationsGranted: boolean;
  locationAccess: LocationAccess;
}

export function DeviceScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [readout, setReadout] = useState<Readout | null>(null);

  const load = useCallback(async () => {
    const [snapshot, batteryLevel, batteryState, network, notificationPermission] =
      await Promise.all([
        AemsUsage.getDeviceSnapshot().catch(() => null),
        Battery.getBatteryLevelAsync().catch(() => -1),
        Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
        Network.getNetworkStateAsync().catch(() => ({ type: undefined })),
        Notifications.getPermissionsAsync().catch(() => ({ granted: false })),
      ]);

    const locationAccess = await checkLocationAccess().catch(
      (): LocationAccess => "denied",
    );

    setReadout({
      snapshot,
      batteryLevel,
      batteryState,
      network: network.type ?? Network.NetworkStateType.UNKNOWN,
      usageAccess: AemsUsage.hasUsageAccess(),
      notificationsGranted: notificationPermission.granted,
      locationAccess,
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

  const snapshot = readout?.snapshot ?? null;

  return (
    <Screen
      title="This device"
      subtitle="The hardware and status details reported alongside your work."
      onRefresh={load}
    >
      <ListSection heading="Hardware">
        <ListRow icon="smartphone" label="Model" value={snapshot?.model ?? "—"} />
        <ListRow icon="cpu" label="Manufacturer" value={snapshot?.manufacturer ?? "—"} />
        <ListRow
          icon="layers"
          label="Android version"
          value={snapshot ? `Android ${snapshot.androidVersion}` : "—"}
        />
        <ListRow icon="server" label="Memory" value={snapshot ? formatMb(snapshot.totalRamMb) : "—"} />
      </ListSection>

      <ListSection heading="Storage & power">
        <ListRow
          icon="hard-drive"
          label="Storage"
          value={
            snapshot
              ? `${formatMb(snapshot.freeStorageMb)} of ${formatMb(snapshot.totalStorageMb)}`
              : "—"
          }
        />
        <ListRow
          icon="battery"
          label="Battery"
          value={readout ? formatBattery(readout.batteryLevel, readout.batteryState) : "—"}
        />
        <ListRow
          icon="wifi"
          label="Network"
          value={readout ? formatNetwork(readout.network) : "—"}
        />
      </ListSection>

      <ListSection
        heading="Permissions"
        footnote="Both are granted in Android's own settings, so these open the system screen."
      >
        <ListRow
          icon={readout?.usageAccess === false ? "alert-triangle" : "check-circle"}
          iconColor={readout?.usageAccess === false ? theme.colors.amber : theme.colors.emerald}
          label="App usage access"
          detail={
            readout?.usageAccess === false
              ? "Turned off. No app usage can be recorded until this is granted."
              : "Working. App usage is being recorded."
          }
          onPress={readout?.usageAccess === false ? () => AemsUsage.requestUsageAccess() : undefined}
        />
        <ListRow
          icon={readout?.notificationsGranted === false ? "alert-triangle" : "check-circle"}
          iconColor={
            readout?.notificationsGranted === false ? theme.colors.amber : theme.colors.emerald
          }
          label="Notifications"
          // Not a nicety: the notification is the visible indicator this product is
          // required to keep showing, so a denial is a compliance gap and is worded as
          // one rather than as a missed alert.
          detail={
            readout?.notificationsGranted === false
              ? "Turned off. Monitoring cannot show its notice on this phone — ask your administrator before continuing."
              : "Working. The monitoring notice stays visible while recording."
          }
          onPress={
            readout?.notificationsGranted === false
              ? () => void Notifications.requestPermissionsAsync()
              : undefined
          }
        />
        {/*
          Three states rather than two, because "granted" and "granted while the app is
          open" fail differently and a single warning would hide which one is in force.
          Foreground-only is the quiet case worth naming: the app looks fine, and the
          trail simply stops whenever the phone goes in a pocket.
        */}
        <ListRow
          icon={readout?.locationAccess === "granted-always" ? "check-circle" : "alert-triangle"}
          iconColor={
            readout?.locationAccess === "granted-always" ? theme.colors.emerald : theme.colors.amber
          }
          label="Location"
          detail={
            readout?.locationAccess === "granted-always"
              ? "Working. Position is recorded while you are clocked in."
              : readout?.locationAccess === "granted-foreground"
                ? "Set to 'While using the app'. Position is only recorded while this app is open — choose 'Allow all the time' to record during work."
                : "Turned off. No location is recorded."
          }
          onPress={
            readout?.locationAccess === "granted-always"
              ? undefined
              : () => void requestLocationAccess().then(load)
          }
        />
      </ListSection>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Everything here is reported to your company alongside your working time.
        </Text>
      </View>
    </Screen>
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
  const { colors, spacing, typography } = theme;

  return StyleSheet.create({
    footer: { paddingHorizontal: spacing.md },
    footerText: { ...typography.footnote, color: colors.muted, textAlign: "center", lineHeight: 18 },
  });
}
