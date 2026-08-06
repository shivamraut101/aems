import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useFonts } from "expo-font";

import { registerBackgroundSync } from "./src/background-task";
import { ConsentScreen } from "./src/screens/ConsentScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { useAgentState } from "./src/state";
import { runSyncCycle } from "./src/sync";
import { fontFamily, useTheme, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from "./src/theme";

const FOREGROUND_SYNC_INTERVAL_MS = 60_000;

/** Restrained per docs/design.md's "avoid heavy animation" — a quick crossfade, not a slide or a bounce. */
const SCREEN_TRANSITION_MS = 220;

/**
 * Root component. Three screens, swapped by hand instead of pulling in a router —
 * login → consent → collecting is a strict progression, so "navigation" here is
 * just how far along it a device is, per `useAgentState`'s `status.screen`.
 */
export default function App() {
  const { status, refresh, login, acceptConsent } = useAgentState();
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

  return (
    <SafeAreaProvider>
      <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
      <Animated.View
        key={status.screen}
        entering={FadeIn.duration(SCREEN_TRANSITION_MS)}
        exiting={FadeOut.duration(SCREEN_TRANSITION_MS)}
        style={{ flex: 1, backgroundColor: theme.colors.background }}
      >
        {status.screen === "login" ? (
          <LoginScreen onLogin={login} />
        ) : status.screen === "consent" ? (
          <ConsentScreen status={status} onAccept={acceptConsent} onAccepted={refresh} />
        ) : (
          <HomeScreen status={status} />
        )}
      </Animated.View>
    </SafeAreaProvider>
  );
}
