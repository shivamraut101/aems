import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useFonts } from "expo-font";

import AemsUsage from "./modules/aems-usage";
import { TabBar, type TabKey } from "./src/components/TabBar";
import { registerBackgroundSync } from "./src/background-task";
import { ActivityScreen } from "./src/screens/ActivityScreen";
import { ConsentScreen } from "./src/screens/ConsentScreen";
import { DeviceScreen } from "./src/screens/DeviceScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { PrivacyScreen } from "./src/screens/PrivacyScreen";
import { RevokedScreen } from "./src/screens/RevokedScreen";
import { useAgentState } from "./src/state";
import { runSyncCycle } from "./src/sync";
import {
  fontFamily,
  ThemePreferenceProvider,
  useTheme,
  useThemePreferenceState,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "./src/theme";

const FOREGROUND_SYNC_INTERVAL_MS = 60_000;

/** Restrained per docs/design.md's "avoid heavy animation" — a quick crossfade, not a slide or a bounce. */
const SCREEN_TRANSITION_MS = 220;

/**
 * The agent proper.
 *
 * Which *screen* shows is still a function of agent state rather than of navigation —
 * login → consent → collecting is a strict progression a tab cannot skip. What tabs
 * add is movement *within* the collecting state, which is where the employee's own
 * data lives: `docs/scope.md` §3.2 and §3.4 are collected on this phone, and until
 * there was somewhere to put them the person they describe was the only one who could
 * not read them.
 */
function AgentApp() {
  const { status, refresh, login, acceptConsent, startDay, endDay, startBreak, endBreak } =
    useAgentState();
  const [tab, setTab] = useState<TabKey>("today");
  const theme = useTheme();
  const [fontsLoaded] = useFonts({
    [fontFamily.regular]: Inter_400Regular,
    [fontFamily.medium]: Inter_500Medium,
    [fontFamily.semibold]: Inter_600SemiBold,
    [fontFamily.bold]: Inter_700Bold,
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Registering the background task only once a device exists avoids it finding
  // no credentials and no-op'ing on every OS-scheduled run in the meantime. It
  // deliberately does not wait for consent — heartbeat runs (and is meant to run)
  // before consent too, so the device shows as online while set-up is pending.
  useEffect(() => {
    if (status.deviceId !== null) {
      void registerBackgroundSync();
    }
  }, [status.deviceId]);

  /**
   * The visible indicator, bound to collection itself rather than to a screen.
   *
   * The foreground service's undismissable notification is this platform's answer to
   * the *Monitoring is never silent* non-negotiable, and its `MonitoringService` is
   * also what feeds `ScreenTimeTracker` — nothing else calls `markScreenOn`.
   *
   * It used to be started from one place: the consent screen's accept handler. That
   * covered the first run and nothing after it, because consent *persists* — every
   * later launch reads it back, goes straight to Home, and never mounts the consent
   * screen at all. So the agent came up collecting, with no notification saying so,
   * and with a screen-time counter that could only ever read 0h 00m.
   *
   * Keyed on `collecting`, the two states can no longer disagree: the notification is
   * up for exactly as long as the agent records, and a revoked device (which lands
   * back on `login` with `collecting: false`) takes it down on the same render.
   *
   * The permission request is not boilerplate. From Android 13, POST_NOTIFICATIONS is
   * a *runtime* grant, and declaring it in app.json only earns the right to ask. Left
   * unasked it stays denied, and the platform then suppresses the notification while
   * running the service anyway — `dumpsys` reports `isForeground=true`, the shade
   * reads "No notifications", and monitoring is silent in the one way the rules do
   * not allow. Asking before `startMonitoring()` is what makes the indicator real.
   */
  useEffect(() => {
    if (!status.collecting) {
      AemsUsage.stopMonitoring();
      return;
    }

    void (async () => {
      const current = await Notifications.getPermissionsAsync();
      if (!current.granted) await Notifications.requestPermissionsAsync();
      AemsUsage.startMonitoring();
    })();
  }, [status.collecting]);

  // Foreground sync only runs once consent is in force — the same gate the sync
  // cycle applies server-side, kept here too so an unconsented device doesn't
  // spend battery polling for work it isn't allowed to report yet.
  useEffect(() => {
    if (status.screen !== "home") return;

    const interval = setInterval(() => {
      void runSyncCycle().then(() => refresh());
    }, FOREGROUND_SYNC_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [status.screen, refresh]);

  if (!fontsLoaded) {
    // No spinner, no flash of system-font text — the background alone reads as a
    // launch screen for the brief moment fonts take to load.
    return <View style={{ flex: 1, backgroundColor: theme.colors.background }} />;
  }

  // Tabs belong to the signed-in, consented state and nothing else. Showing them
  // during sign-in or on the consent gate would offer a way around a screen that is
  // deliberately blocking — the consent gate in particular must be answered, not
  // navigated past.
  const tabbed = status.screen === "home";

  return (
    <SafeAreaProvider>
      <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Animated.View
          key={tabbed ? `home:${tab}` : status.screen}
          entering={FadeIn.duration(SCREEN_TRANSITION_MS)}
          exiting={FadeOut.duration(SCREEN_TRANSITION_MS)}
          style={{ flex: 1 }}
        >
          {status.screen === "login" ? (
            <LoginScreen onLogin={login} />
          ) : status.screen === "revoked" ? (
            <RevokedScreen policyVersion={status.policyVersion} />
          ) : status.screen === "consent" ? (
            <ConsentScreen status={status} onAccept={acceptConsent} onAccepted={refresh} />
          ) : tab === "activity" ? (
            <ActivityScreen />
          ) : tab === "device" ? (
            <DeviceScreen />
          ) : tab === "privacy" ? (
            <PrivacyScreen policyVersion={status.policyVersion} />
          ) : (
            <HomeScreen
              status={status}
              onStartBreak={startBreak}
              onEndBreak={endBreak}
              onStartDay={startDay}
              onEndDay={endDay}
            />
          )}
        </Animated.View>

        {tabbed ? <TabBar active={tab} onSelect={setTab} /> : null}
      </View>
    </SafeAreaProvider>
  );
}

/**
 * Wraps the app in the stored appearance preference.
 *
 * It has to sit outside `AgentApp` rather than inside it: `useTheme()` reads this
 * context, and a provider mounted in the same component that consumes it would leave
 * every `useTheme()` call in the tree below reading the default instead.
 */
export default function App() {
  const themePreference = useThemePreferenceState();

  useEffect(() => {
    // Keeps the system chrome behind the app in step with the chosen appearance —
    // without it a light theme keeps a navy navigation bar underneath it.
    void SystemUI.setBackgroundColorAsync(
      themePreference.preference === "dark" ? "#020617" : "#F8FAFC",
    );
  }, [themePreference.preference]);

  return (
    <ThemePreferenceProvider value={themePreference}>
      <AgentApp />
    </ThemePreferenceProvider>
  );
}
